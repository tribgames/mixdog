/**
 * The ordinary session catalog engine: summary index (base + delta log),
 * session-file reconcile and the background verification. Turn liveness is
 * not part of it: the daemon overlays its in-memory runtime state on the rows
 * it serves.
 *
 * Leaf by design (no store.mjs, no config, no workers): the cold reader
 * (store-summary-reader.mjs) runs one instance on its own thread for the JSON
 * path, and the session catalog DB worker (catalog-db/worker.mjs) runs another
 * that feeds SQLite. Both therefore detect exactly the same changes.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
// Leaf helpers only: the three-way present/absent/unreadable classification
// and the strict record parser the authoritative store uses, so the catalog
// cannot disagree with it.
import { readFileStep, PROBE_PRESENT, PROBE_ABSENT, PROBE_UNREADABLE } from './store/fs-probe.mjs';
import {
  ABSENT_RECORD_STAMP,
  isAbsentReadError,
  isSettledRecordStamp,
  logLegacyProof,
  readSessionRecordStep,
  recordSession,
  presentFilesKeepStamp,
  recordStampFingerprint,
  sessionRecordFiles,
  sessionRecordPresenceOfNames,
  sessionRecordStampStep,
  stampKeepsLogRecord,
  stampMatchesPresence,
} from './store/session-record.mjs';
// The catalog's reads are store-read steps: the ordinary catalog runs them
// with blocking calls (its own thread in the catalog DB worker, cheap stamp
// checks on the JSON path), the daemon's storage refresh awaits every one.
import { runFsStepsAsync, runFsStepsSync } from './store/fs-steps.mjs';
import { isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { readStrictRecordFields } from './store-record-strict-scan.mjs';
import { isAgentOnlySession, isRootLeadSession, sessionVisibility } from './store-summary-visibility.mjs';
import {
  SUMMARY_PAIR_ATTEMPTS,
  applySummaryLogText,
  movedSummaryRow,
  summaryBaseIdentityStep,
  summaryLogPath,
} from './store-summary-log.mjs';
import { dataDir } from './store-summary-locations.mjs';
import { normalizeRoutineProvenance } from './routine-result.mjs';
import { lastMessageLine, lastMessageSummary, normalizedIncomingTail } from './store-summary-last-message.mjs';
import {
  desktopSession,
  importKey,
  inheritedFromSessionId,
  isStoredSessionId,
  positiveNumber,
  compactCountField,
  realTurnCount,
  workspaceSummary,
} from './store-summary-fields.mjs';
import { isRealTurnMessage } from './compact/user-message-kind.mjs';
import { sessionModeOf } from './agent-mode.mjs';
import { byActivityThenId } from './catalog-db/schema.mjs';
import { sessionStampOf, sameSessionStamp, isSettledSessionStamp } from './store/canonical-reader.mjs';

export const STAMP_ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** The one catalog order of every listing path (JSON and DB): newest
 *  conversation activity first (see normalizedRow's lastUsedAt note), ties by
 *  id, so a fallback and the DB never disagree on equal activity times. */
const byCatalogOrder = byActivityThenId;

// ── Stamp-keyed strict derivations ──────────────────────────────────────────
// Session metadata and catalog rows are small values derived from a session
// record resolved through the record seam (store/session-record.mjs). They
// are reused only while the record still has the stamp (log and json) the
// resolved record was proven to come from (stamp → read → stamp) and that
// stamp is past the racy window. Any other record — changed, replaced by
// another writer, unreadable — is read again.
// Bounded by count and by serialized size: nothing tells this map a session
// went away, so a churning host fills it with dead keys until LRU
// eviction (`delete` + `set` on a hit keeps Map order least recent first).
const STAMPED_DERIVATION_LIMIT = 2048;
const STAMPED_DERIVATION_MAX_BYTES = 8 * 1024 * 1024;
const stampedDerivations = new Map(); // `${kind}|${directory}|${id}` → { stamp, value, bytes }
let stampedDerivationBytes = 0;

function dropStampedDerivation(key) {
  const entry = stampedDerivations.get(key);
  if (!entry) return;
  stampedDerivations.delete(key);
  stampedDerivationBytes -= entry.bytes;
}

const BIGINT_STAT = Object.freeze({ bigint: true });

/** The full stamp of `path` as a store-read step; throws like the stat. */
function* statStampStep(path) {
  return sessionStampOf(yield ['stat', path, BIGINT_STAT]);
}

/** statStampStep, null when the stat fails. */
function* observeStampStep(path) {
  try {
    return yield* statStampStep(path);
  } catch {
    return null;
  }
}

export function observeStamp(path) {
  return runFsStepsSync(observeStampStep(path));
}

/** The record stamp of session `sessionId` of `directory`, null when it
 *  cannot be taken. */
function* observeRecordStampStep(directory, sessionId) {
  try {
    return yield* sessionRecordStampStep(directory, sessionId);
  } catch {
    return null;
  }
}

/** `{ state, value }`: `derive(outcome)` for session `sessionId` of
 *  `directory` resolved through the record seam (`loadLegacy`, `messages`:
 *  the seam read), or its cached result while the record is provably
 *  unchanged. `stamp`: the caller's own record stamp, taken just before,
 *  stands for the pre-read stamp (one stat pair fewer). */
export function stampedDerivation(kind, directory, sessionId, derive, options) {
  return runFsStepsSync(stampedDerivationSteps(kind, directory, sessionId, derive, options));
}

function* stampedDerivationSteps(kind, directory, sessionId, derive, { loadLegacy, messages = true, stamp } = {}) {
  const key = `${kind}|${directory}|${sessionId}`;
  const before = stamp === undefined ? yield* observeRecordStampStep(directory, sessionId) : stamp;
  const cached = stampedDerivations.get(key);
  if (before && cached && cached.stamp === before) {
    stampedDerivations.delete(key);
    stampedDerivations.set(key, cached);
    return { state: PROBE_PRESENT, value: cached.value };
  }
  dropStampedDerivation(key);
  let outcome;
  try {
    outcome = yield* readSessionRecordStep(directory, sessionId, { loadLegacy, messages, stamp: before });
  } catch (error) {
    return { state: isAbsentReadError(error) ? PROBE_ABSENT : PROBE_UNREADABLE, value: null };
  }
  if (outcome.kind === 'absent') return { state: PROBE_ABSENT, value: null };
  const value = derive(outcome);
  if (isSettledRecordStamp(before) && before === (yield* observeRecordStampStep(directory, sessionId))) {
    // UTF-16 code units of the key and the serialized value approximate the
    // retained bytes; the strict parse just above dwarfs this stringify.
    const size = 2 * (key.length + (JSON.stringify(value)?.length ?? 0));
    if (size <= STAMPED_DERIVATION_MAX_BYTES) {
      // An awaited derivation of the same file may have landed meanwhile.
      dropStampedDerivation(key);
      stampedDerivations.set(key, { stamp: before, value, bytes: size });
      stampedDerivationBytes += size;
      while (
        stampedDerivations.size > STAMPED_DERIVATION_LIMIT ||
        stampedDerivationBytes > STAMPED_DERIVATION_MAX_BYTES
      ) {
        dropStampedDerivation(stampedDerivations.keys().next().value);
      }
    }
  }
  return { state: PROBE_PRESENT, value };
}

const SESSION_SUMMARY_INDEX_VERSION = 2;

// Catalog visibility: Agent sessions are listed like any other session (the
// desktop sidebar filters to Leads itself), while internal dispatches the
// engine cannot open (memory ingest chunks, judges, exec runs) stay out — a
// click on such a row dead-ends in "Session is not available." (user report).
const LEAD_OWNERS = new Set(['cli', 'user', 'mixdog']);

export function isLeadVisibleRow(row) {
  const owner = String(row.owner || 'user')
    .trim()
    .toLowerCase();
  const agentSession = isAgentOnlySession(row) || owner === 'agent';
  if (!agentSession && !isRootLeadSession(row) && owner && !LEAD_OWNERS.has(owner)) return false;
  // Mirror listLeadSessions: a previewless zero-message row is an unusable
  // scratch (desktop boot leftovers, crashed first turns) — resuming it
  // shows an empty conversation, so the catalog hides it. A titled one is a
  // real conversation whose prompts were rewound away: it stays listed.
  if (!row.preview && row.messageCount === 0 && !row.title) return false;
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
    agentSession ||
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

export function normalizedRow(row) {
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
    closed: row.closed === true,
    status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
    owner: row.owner || 'user',
    agent: row.agent || null,
    sessionMode: sessionModeOf(row),
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
    // Absent from a row read off a session file: its assistant text is not
    // decoded there, so the unread count falls back until the next save.
    ...(Array.isArray(row.incomingTail) ? { incomingTail: normalizedIncomingTail(row.incomingTail) } : {}),
    // Absent from a row read off a session file (its compaction record is not
    // decoded there) until the next save.
    ...compactCountField(row),
    realTurnCount: realTurnCount(row),
    title: cleanText(row.title, 100),
    preview: cleanText(row.preview),
    lastMessagePreview: cleanText(row.lastMessagePreview),
    // Null for any line that is not a routine result, and on rows written
    // before the marker existed (they show their plain text).
    lastMessageRoutine: normalizeRoutineProvenance(row.lastMessageRoutine),
    generation: typeof row.generation === 'number' ? row.generation : 0,
    storageMtimeMs: positiveNumber(row.storageMtimeMs, 0),
    storageSize: positiveNumber(row.storageSize, 0),
    detachedReason: row.detachedReason || null,
    importKey: importKey(row),
    inheritedFromSessionId: inheritedFromSessionId(row),
  };
}

function leadRows(rows) {
  return rows.filter((row) => row && isLeadVisibleRow(row));
}

// What a row derivation decodes of a record (store-record-strict-scan.mjs):
// rowFromSession reads its user messages whole, the newest messages back to
// the one with a last-message line whole too, only the role of the rest, and
// never these top-level fields — together ~10% of a record, mostly tool
// catalogs. Every other top-level field is decoded, so a field a row starts
// to read is there without touching this list.
const CATALOG_RECORD_READ = {
  skip: new Set([
    'tools',
    'deferredToolCatalog',
    'deferredLateToolCatalog',
    'bp3CoreContext',
    'bp3EnvironmentContext',
    'compaction',
    'pendingDeferredToolDelta',
  ]),
  fullMessageRoles: new Set(['user']),
  fullTailUntil: (message) => Boolean(lastMessageLine(message)),
};

function rowFromSession(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  // The first user message with text left after cleaning: later messages are
  // never cleaned (a long conversation's pasted logs cost seconds of regex
  // work on the loop otherwise).
  let preview = '';
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const text = messageText(message.content);
    // Cold-path mirror of isSessionPreviewNoise's synthetic skips: compact
    // handoffs and runtime notices must not become session titles.
    if (
      /^\s*(?:a previous model worked on this task|re-attached after compaction\b|reference files:\s|\[mixdog-runtime\]|the async (?:agent|shell) task\b)/i.test(
        text
      )
    ) {
      continue;
    }
    preview = cleanText(text);
    if (preview) break;
  }
  // The last-message line comes from the transcript like the summary index
  // derives it; without it a session saved after the index was written lost
  // its contact-row preview whenever its row came from this file read.
  return normalizedRow({
    ...session,
    messageCount: messages.filter((message) => message?.role === 'user' || message?.role === 'assistant').length,
    realTurnCount: messages.filter(isRealTurnMessage).length,
    preview,
    ...lastMessageSummary(messages),
  });
}

/** The catalog row of one session read off its record in `<directory>` by
 *  id — the same strict, stamp-cached derivation a listing uses — or null
 *  when it is absent, unreadable, foreign or not one the catalog lists. */
export function storedSessionCatalogRow(directory, sessionId) {
  if (!isStoredSessionId(sessionId)) return null;
  const entry = reconcileSessionFile(directory, sessionId, null, false);
  return entry?.kind === 'row' && isLeadVisibleRow(entry.row) ? entry.row : null;
}

// ── Session record reconcile ────────────────────────────────────────────────
// What one session id (a `sessions/<id>.log.jsonl` or `<id>.json`, see
// store/session-record.mjs) contributes to the catalog, with the record
// stamp it was judged at (and the { mtimeMs, size } fingerprint of the file
// holding the record — the log, else the json — the summary index records):
//   indexed     its summary-index row (the record matches the row's fingerprint)
//   row         a row read from the record (the index does not describe it)
//   none        read, but yields no row (ambiguous, foreign or invalid record)
//   unreadable  present but not statable/readable: the index row is retained
const UNREADABLE_ENTRY = Object.freeze({ kind: 'unreadable', stamp: null, mtimeMs: 0, size: 0 });

// The legacy json of a row: the same strict authority as the store — a
// duplicate/ambiguous top-level record or a foreign identity is not this
// session — decoding only what a row is made of (see CATALOG_RECORD_READ).
function loadCatalogLegacy(text, sessionId) {
  const record = readStrictRecordFields(Buffer.from(text, 'utf8'), CATALOG_RECORD_READ);
  return isLifecycleUnreadable(record) || record.id !== sessionId ? null : record.doc;
}

/** The entry for session `storageId`, or null when its record is provably gone. */
function reconcileSessionFile(directory, storageId, retained, forceRead) {
  return runFsStepsSync(reconcileSessionFileSteps(directory, storageId, retained, forceRead));
}

function* reconcileSessionFileSteps(directory, storageId, retained, forceRead) {
  let stamp;
  try {
    stamp = yield* sessionRecordStampStep(directory, storageId);
  } catch {
    return UNREADABLE_ENTRY;
  }
  // Provably gone: the row legitimately disappears with the record.
  if (stamp === ABSENT_RECORD_STAMP) return null;
  const fingerprint = { stamp, ...recordStampFingerprint(stamp) };
  const describesFile = (file) =>
    Boolean(retained) &&
    retained.storageMtimeMs > 0 &&
    retained.storageSize > 0 &&
    retained.storageMtimeMs === file.mtimeMs &&
    retained.storageSize === file.size;
  // A row of a log also needs the json beside it to leave the log the record
  // (a json an older build rewrote is the record then): stats only, the
  // seam's own rule (stampKeepsLogRecord).
  if (!forceRead && describesFile(fingerprint) && stampKeepsLogRecord(stamp, indexRowLogProof.get(retained))) {
    return { kind: 'indexed', ...fingerprint };
  }
  // A record the index does not describe (never saved by the store, or
  // saved after the index was written) is read once per record stamp; the
  // stamp above is the read's pre-read stamp.
  const read = yield* stampedDerivationSteps(
    'row',
    directory,
    storageId,
    (outcome) => {
      const session = recordSession(outcome, storageId);
      const row = session ? rowFromSession(session) : null;
      if (!row) return null;
      const fromLog = outcome.kind === 'log' || outcome.kind === 'orphan';
      return { row, base: conversionBaseOf(outcome), proof: fromLog ? logLegacyProof(outcome.log.legacy) : null };
    },
    { loadLegacy: loadCatalogLegacy, stamp }
  );
  if (read.state === PROBE_ABSENT) return null;
  // Exists and could not be read (EACCES/EIO): retain the last known row
  // rather than let a transient IO error delete it from view.
  if (read.state !== PROBE_PRESENT) return UNREADABLE_ENTRY;
  if (!read.value) return { kind: 'none', ...fingerprint };
  const { base, proof } = read.value;
  // The read proved the log is the record. The index row describes it when
  // it was written from the json this log is still exactly the conversion
  // of, or from this very log (only its json proof was missing or stale).
  // `moved` asks the index owner to re-point the row at the log with that
  // proof, so the read is not repeated.
  if (!forceRead && proof !== null && ((base && describesFile(base)) || describesFile(fingerprint))) {
    const from = { mtimeMs: retained.storageMtimeMs, size: retained.storageSize };
    return { kind: 'indexed', ...fingerprint, moved: { from, proof } };
  }
  return {
    kind: 'row',
    row: deepFreeze({
      ...structuredClone(read.value.row),
      storageMtimeMs: fingerprint.mtimeMs,
      storageSize: fingerprint.size,
    }),
    ...fingerprint,
  };
}

/** `{ mtimeMs, size }` of the legacy json a log is the untouched conversion
 *  of (its base and nothing after it, written from that json), or null. */
function conversionBaseOf(outcome) {
  if (outcome?.kind !== 'log' && outcome?.kind !== 'orphan') return null;
  const { log } = outcome;
  const pristine =
    log.valid && log.seq === 1 && log.prev === null && !log.tornTail && !log.damage && log.skipped.length === 0;
  if (!pristine || !(Number(log.legacy?.mtimeMs) > 0) || !(Number(log.legacy?.size) > 0)) return null;
  return { mtimeMs: log.legacy.mtimeMs, size: log.legacy.size };
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

/** Session id → which of its files (`<id>.json`, `<id>.log.jsonl`)
 *  `directory` holds, or null when it cannot be enumerated. */
function* listSessionRecordPresenceStep(directory) {
  let names;
  try {
    names = yield ['readdir', directory];
  } catch {
    return null;
  }
  return sessionRecordPresenceOfNames(names);
}

/** The session ids of `directory`, or null when it cannot be enumerated. */
function* listSessionIdsStep(directory) {
  const presence = yield* listSessionRecordPresenceStep(directory);
  return presence && [...presence.keys()];
}

/** Every session entry of an enumerable `directory`, or null when it cannot
 *  be enumerated. */
function* scanSessionEntriesSteps(directory, indexRowsById, forceRead) {
  const sessionIds = yield* listSessionIdsStep(directory);
  if (!sessionIds) return null;
  const entries = new Map();
  for (const storageId of sessionIds) {
    const entry = yield* reconcileSessionFileSteps(directory, storageId, indexRowsById.get(storageId), forceRead);
    if (entry) entries.set(storageId, entry);
  }
  return { entries };
}

/** The entry a file still has: `entry` when the file's stamp is unchanged
 *  since it was reconciled, else a fresh reconcile (null once it is gone). */
function* settledEntrySteps(directory, storageId, entry, retained, forceRead) {
  if (entry?.stamp) {
    // Gone or unstatable: the reconcile below decides which.
    const stamp = yield* observeRecordStampStep(directory, storageId);
    if (stamp === entry.stamp) return entry;
  }
  return yield* reconcileSessionFileSteps(directory, storageId, retained, forceRead);
}

/** scanSessionEntriesSteps run awaited (see runFsStepsAsync), one file at a
 *  time: a full authoritative rescan strict-reads every session file (≈4 s
 *  for 1.8k files / 1.3 GB), and neither the whole scan nor one slow read may
 *  hold the daemon loop. Files change while it awaits, so the answer is
 *  settled by one final pass: the directory is listed again, a file whose
 *  stamp moved since its read (or that appeared) is reconciled again, and a
 *  file that is no longer listed is dropped — the entries match storage as
 *  that pass saw it. That pass is a stat per file, so the work is bounded by
 *  the store, never by how fast it is written to. Resolves `{ entries,
 *  dirStamp }`, `dirStamp` being the directory's stamp taken just before that
 *  pass: a catalog installed under it is found changed by the next refresh's
 *  stamp check when a create, delete or rename lands after the pass, which is
 *  all the steady state offers any catalog (the index upserts of the store's
 *  own saves and the background verification cover the rest). Null when the
 *  directory cannot be enumerated. */
function* scanSessionEntriesSettledSteps(directory, indexRowsById, forceRead, onSettle) {
  const scan = yield* scanSessionEntriesSteps(directory, indexRowsById, forceRead);
  onSettle?.();
  if (!scan) return null;
  const dirStamp = yield* observeStampStep(directory);
  const settledIds = yield* listSessionIdsStep(directory);
  if (!settledIds) return null;
  const entries = new Map();
  for (const storageId of settledIds) {
    const entry = yield* settledEntrySteps(
      directory,
      storageId,
      scan.entries.get(storageId),
      indexRowsById.get(storageId),
      forceRead
    );
    if (entry) entries.set(storageId, entry);
  }
  return { entries, dirStamp };
}

/** The row an entry contributes, or null. */
function entryRow(entry, id, indexRowsById) {
  if (!entry || entry.kind === 'none') return null;
  return (entry.kind === 'row' ? entry.row : indexRowsById.get(id)) || null;
}

/** Catalog rows of reconciled `entries`, in catalog order. */
function assembleCatalog(entries, indexRowsById) {
  const rows = [];
  for (const [id, entry] of entries) {
    const row = entryRow(entry, id, indexRowsById);
    // A copy: the cached entry rows are frozen and shared.
    if (row) rows.push({ ...row });
  }
  return leadRows(rows).sort(byCatalogOrder);
}

/**
 * Read-only scan of the authoritative session files, every file's I/O
 * awaited (the daemon's session.list storage refresh). Resolves `null` when the directory itself is NOT enumerable
 * (unreadable stat / readdir): that is not "no sessions", and the caller must
 * keep the authority it already has (the index rows) instead of publishing an
 * empty catalog. `indexRowsById` carries those rows so unchanged files can
 * reuse the durable summary and a single UNREADABLE file retains its last
 * known row instead of vanishing. `onSettle` runs once, when the answer's
 * final pass begins: a caller asking later must not be handed this answer.
 * `root`: the data dir to scan (default: the current one).
 */
export async function scanSessionFilesAsync(indexRowsById, forceRead, { onSettle, root = dataDir() } = {}) {
  const directory = join(root, 'sessions');
  try {
    await stat(directory);
  } catch (error) {
    onSettle?.();
    return STAMP_ABSENT_CODES.has(error?.code) ? [] : null;
  }
  const scan = await runFsStepsAsync(scanSessionEntriesSettledSteps(directory, indexRowsById, forceRead, onSettle));
  return scan && assembleCatalog(scan.entries, indexRowsById);
}

/** Listing from the index rows alone, or null without a valid index. */
export function indexListing(index) {
  return index.rows && leadRows(index.rows.map((row) => ({ ...row }))).sort(byCatalogOrder);
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

// The log proof (`storageLegacy`, see session-record.mjs logLegacyProof) of
// each index row: not a catalog field, so neither listings nor the catalog DB
// carry it; only the reconcile reads it.
const indexRowLogProof = new WeakMap();

/** The frozen catalog row of a raw index row (null when it is none), with
 *  its log proof kept beside it. */
function indexRowOf(raw) {
  const row = normalizedRow(raw);
  if (!row) return null;
  deepFreeze(row);
  if (typeof raw.storageLegacy === 'string') indexRowLogProof.set(row, raw.storageLegacy);
  return row;
}

function sameOptionalStamp(left, right) {
  return (!left && !right) || sameSessionStamp(left, right);
}

/** `{ bytes, failed }`: the log, empty when absent; `failed` when it exists
 *  and could not be read (EACCES/EIO), which is never cached. */
function* readLogBytesStep(logPath) {
  const read = yield* readFileStep(logPath, true);
  return { bytes: read.bytes, failed: read.state !== PROBE_PRESENT && read.state !== PROBE_ABSENT };
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
function* readSummaryIndexSteps(cached) {
  const indexPath = join(dataDir(), 'session-summaries.json');
  let baseStamp = yield* observeStampStep(indexPath);
  let logStamp = yield* observeStampStep(summaryLogPath(indexPath));
  if (cached?.indexPath !== indexPath) cached = null;
  if (cached && sameOptionalStamp(cached.baseStamp, baseStamp) && sameOptionalStamp(cached.logStamp, logStamp)) {
    return { index: cached, cacheable: true };
  }
  // The delta log (per-session updates since the last compaction) is read
  // before the base; see store-summary-log.mjs. A compaction replaces the base
  // and then empties the log, so the pair is only whole when the base is the
  // same file after both reads: a log read before a compaction must not be
  // laid over the base read after it (older rows over newer ones).
  for (let attempt = 0; attempt < SUMMARY_PAIR_ATTEMPTS; attempt += 1) {
    const identity = yield* summaryBaseIdentityStep(indexPath);
    // Stamps are taken after the identity and again on every attempt: they say
    // which base the cached rows may be extended from, and a stamp left over
    // from before a compaction would authorize rows of the replaced base for
    // the new one (a truncated log passes the prefix check when none is cached).
    // A replacement between the identity and the stamps fails the check below.
    baseStamp = yield* observeStampStep(indexPath);
    logStamp = yield* observeStampStep(summaryLogPath(indexPath));
    const log = yield* readLogBytesStep(summaryLogPath(indexPath));
    const index = freshIndex(indexPath, baseStamp, logStamp, log.bytes);
    const appliedBytes = cached?.logBytes.length ?? 0;
    if (
      !log.failed &&
      cached?.rows &&
      sameOptionalStamp(cached.baseStamp, baseStamp) &&
      index.logBytes.length >= appliedBytes &&
      index.logBytes.compare(cached.logBytes, 0, appliedBytes, 0, appliedBytes) === 0
    ) {
      // The cached rows extended by this log are one snapshot only while the
      // base was not replaced meanwhile: a compaction folded the log read
      // here into a newer base, which a fresh read answers.
      if ((yield* summaryBaseIdentityStep(indexPath)) !== identity) continue;
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
          const row = indexRowOf(op.u);
          if (row) rowsById.set(row.id, row);
          else rowsById.delete(op.u.id);
          touched.add(op.u.id);
        } else if (Array.isArray(op?.r)) {
          for (const id of op.r) {
            rowsById.delete(id);
            touched.add(id);
          }
        } else if (typeof op?.m?.id === 'string') {
          const moved = movedSummaryRow(rowsById.get(op.m.id), op.m);
          if (moved) {
            rowsById.set(op.m.id, indexRowOf(moved));
            touched.add(op.m.id);
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
    const indexRead = yield* readFileStep(indexPath);
    if ((yield* summaryBaseIdentityStep(indexPath)) !== identity) continue;
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
      .rows.map(indexRowOf)
      .filter(Boolean);
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
  // Two reads in a row came out across a compaction: the files are the authority.
  return { index: freshIndex(indexPath, baseStamp, logStamp, Buffer.alloc(0)), cacheable: false };
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
// from cheap stamps alone: the index pair (above) and the sessions DIRECTORY —
// no per-session-file filesystem work.
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

/** refreshSteps without a cold scan found no catalog to reconcile. */
const NEEDS_COLD_SCAN = Symbol('needs-cold-scan');

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
function* reconcileKnownCatalogSteps(catalog, directory, dirStamp, index, hinted) {
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
    const present = yield* listSessionRecordPresenceStep(directory);
    if (!present) return null;
    for (const id of catalog.entries.keys()) {
      if (present.has(id)) continue;
      catalog.entries.delete(id);
      changedIds.add(id);
      changed = true;
    }
    // A name that appeared, or a session that gained or lost one of its two
    // files (a log created beside its json): the background pass stats only
    // the files an entry's stamp shows, so this is where such a change shows.
    for (const [id, files] of present) {
      const entry = catalog.entries.get(id);
      if (!entry || (entry.stamp && !stampMatchesPresence(entry.stamp, files))) ids.add(id);
    }
    catalog.dirStamp = dirStamp;
    catalog.dirSettled = isSettledSessionStamp(dirStamp);
  }
  for (const id of ids) {
    const before = catalog.entries.get(id);
    const entry = yield* reconcileSessionFileSteps(directory, id, index.rowsById.get(id), forced.has(id));
    // Awaited, another refresh may have reconciled this id meanwhile (it
    // read later than this one began): its entry stands.
    if (catalog.entries.get(id) === before) {
      if (entry) catalog.entries.set(id, entry);
      else catalog.entries.delete(id);
    }
    changedIds.add(id);
    changed = true;
  }
  return { changed, changedIds };
}

/** Marks every entry of `snapshot` whose record files no longer have the
 *  stamp they were judged at dirty (a replacement brings a new inode even
 *  when its size and mtime match). A file the stamp shows absent is not
 *  stat-ed: it can only appear by a create, which the directory stamp check
 *  of reconcileKnownCatalogSteps catches. Stops early once `isCurrent()` is
 *  false. */
async function markChangedEntriesDirty(catalog, snapshot, isCurrent) {
  for (let start = 0; start < snapshot.length; start += CATALOG_VERIFY_BATCH) {
    if (!isCurrent()) return;
    await Promise.all(
      snapshot.slice(start, start + CATALOG_VERIFY_BATCH).map(async ([id, entry]) => {
        let changed;
        try {
          changed =
            entry.kind === 'unreadable' ||
            !(await presentFilesKeepStamp(sessionRecordFiles(catalog.directory, id), entry.stamp));
        } catch {
          changed = entry.kind !== 'unreadable';
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
  // Bumped by clear(): a build that started before it must not install.
  let clearEpoch = 0;
  let building = null;
  const reportedMoves = new WeakSet();

  function adoptIndex({ index, cacheable }) {
    if (cacheable) summaryIndexCache = index;
    return index;
  }

  function loadIndex() {
    return adoptIndex(runFsStepsSync(readSummaryIndexSteps(summaryIndexCache)));
  }

  /** loadIndex with every stat and read awaited. */
  async function loadIndexAsync() {
    return adoptIndex(await runFsStepsAsync(readSummaryIndexSteps(summaryIndexCache)));
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
  function refresh(index, options) {
    return runFsStepsSync(refreshSteps(index, options, scanSessionEntriesSteps));
  }

  /** refresh with every stat, listing and read awaited, for the daemon loop.
   *  A first (cold) catalog is built by `warm`, never here. The listing is
   *  what refresh() answers at the moment this resolves: a clear() meanwhile
   *  makes the answer start over against the new state. */
  async function refreshAsync(index, options) {
    for (;;) {
      const epoch = clearEpoch;
      const result = await runFsStepsAsync(refreshSteps(index, options, null));
      if (result === NEEDS_COLD_SCAN) {
        if (!(await warm(index))) return unlistableRefresh();
        // The build took a while: the index upserts of saves that landed
        // meanwhile are what re-reconciles those sessions.
        index = await loadIndexAsync();
      } else if (epoch === clearEpoch) {
        return result;
      }
    }
  }

  /** `coldScan(directory, indexRowsById, forceRead)`: the steps that build the
   *  first catalog, or null when the caller must have one built first (then
   *  NEEDS_COLD_SCAN). */
  function* refreshSteps(index, { assemble = true } = {}, coldScan) {
    const directory = join(dataDir(), 'sessions');
    let dirStamp;
    try {
      dirStamp = yield* statStampStep(directory);
    } catch (error) {
      dropSessionCatalog();
      const absent = STAMP_ABSENT_CODES.has(error?.code);
      return { rows: absent ? [] : null, catalog: null, fresh: false, changedIds: null, absent };
    }
    let catalog = sessionCatalog?.directory === directory ? sessionCatalog : null;
    const fresh = !catalog;
    if (fresh && !coldScan) return NEEDS_COLD_SCAN;
    let changed = true;
    let changedIds = new Set();
    const hinted = hintedIds;
    hintedIds = new Set();
    if (fresh) {
      const scan = yield* coldScan(directory, index.rowsById, false);
      if (!scan) return unlistableRefresh();
      catalog = newSessionCatalog(directory, dirStamp, index, scan);
      sessionCatalog = catalog;
    } else {
      const reconciled = yield* reconcileKnownCatalogSteps(catalog, directory, dirStamp, index, hinted);
      if (!reconciled) {
        if (sessionCatalog === catalog) dropSessionCatalog();
        return unlistableRefresh();
      }
      ({ changed, changedIds } = reconciled);
    }
    if (changed) catalog.rows = null;
    if (assemble) rowsOf(catalog);
    if (sessionCatalog === catalog) armCatalogVerify(catalog);
    // Rows (and everything in them) are frozen: callers share them read-only.
    return { rows: assemble ? catalog.rows.slice() : null, catalog, fresh, changedIds, absent: false };
  }

  /** Starts the awaited cold build of the catalog of `directory`. */
  function startBuild(directory, index) {
    const flight = { directory, epoch: clearEpoch, done: null };
    flight.done = (async () => {
      try {
        const scan = await runFsStepsAsync(scanSessionEntriesSettledSteps(directory, index.rowsById, false));
        if (!scan) return false;
        // A clear() since the build began means its scan describes a catalog
        // that was dropped on purpose: the waiters build again.
        if (flight.epoch === clearEpoch && sessionCatalog?.directory !== directory) {
          dropSessionCatalog();
          sessionCatalog = newSessionCatalog(directory, scan.dirStamp, index, scan);
        }
        return true;
      } finally {
        if (building === flight) building = null;
      }
    })();
    return flight;
  }

  /**
   * Resolves once a catalog of the sessions directory is installed (true), or
   * false when the directory cannot be enumerated. The first catalog is built
   * with every stat, listing and read awaited, so the daemon loop is never
   * held for the whole cold scan, and it is installed under the directory
   * stamp its last clean pass ended on (see scanSessionEntriesSettledSteps),
   * so a refresh right after it only reconciles what changed since. Callers
   * share one build; one that a clear() invalidated is followed by the next.
   */
  async function warm(index) {
    const directory = join(dataDir(), 'sessions');
    for (;;) {
      if (sessionCatalog?.directory === directory) return true;
      if (building?.directory !== directory || building.epoch !== clearEpoch) building = startBuild(directory, index);
      const flight = building;
      const built = await flight.done;
      if (flight.epoch === clearEpoch) return built;
    }
  }

  /** The (frozen) listing of a reconciled catalog, assembled on demand. */
  function rowsOf(catalog) {
    catalog.rows ||= assembleCatalog(catalog.entries, catalog.index.rowsById).map(Object.freeze);
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
    loadIndexAsync,
    refresh,
    refreshAsync,
    rowsOf,
    /** The row `id` contributes to the current catalog. */
    entryRow: (catalog, id) => entryRow(catalog.entries.get(id), id, catalog.index.rowsById),
    current: () => sessionCatalog,
    /** Index fingerprint moves (`{ id, from, to }`, see store-summary-log.mjs)
     *  for the entries of the current catalog that matched their index row
     *  only through the log's conversion base; each entry is handed out once. */
    takeIndexMoves() {
      const moves = [];
      if (!sessionCatalog) return moves;
      for (const [id, entry] of sessionCatalog.entries) {
        if (!entry.moved || reportedMoves.has(entry)) continue;
        reportedMoves.add(entry);
        const { from, proof } = entry.moved;
        moves.push({ id, from, to: { mtimeMs: entry.mtimeMs, size: entry.size, legacy: proof } });
      }
      return moves;
    },
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
      clearEpoch += 1;
      building = null;
      dropSessionCatalog();
      summaryIndexCache = null;
      hintedIds = new Set();
    },
  };
}
