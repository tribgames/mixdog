// sweep/sweep-record.mjs
// What the stale-session sweep reads per record and the bounds it decides
// with: the fingerprint-cached lifecycle record and the
// idle / retention / blank-scratch thresholds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdsNoData, writeJsonAtomicSync } from '../../../../../shared/atomic-file.mjs';
import { getPluginData } from '../../../config.mjs';
import { loadLegacySession, readSessionRecordSync, recordLifecycle } from '../session-record.mjs';

export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes idle — aligned with Anthropic 5m messages tier and OpenAI in-memory cache window
// Hard wall-clock ceiling for sessions stuck in status='running'. The
// stream-watchdog should abort stalled streams within ~120s, but if it misses
// one (process crash, watchdog not started, provider never returned), this
// backstop reclaims the file so the sweep doesn't leak zombies indefinitely.
export const RUNNING_STALL_MS = 10 * 60 * 1000;
// Retention cap for resumable OPEN (non-tombstone) sessions. Lead/user resume
// closes sessions with { tombstone:false } — the runtime detaches but the
// session JSON stays open/resumable and is never lifecycle-closed, so without
// a cap the sessions/ dir grows without bound (observed 782 open files). The
// sweep prunes open sessions past EITHER bound: older than 14d, or beyond the
// newest 300 (oldest first). The cap targets ONLY ephemeral agent/ownerless
// sessions — explicit USER-owned conversations are never auto-pruned (deleting
// a user's history, including the current foreground session which is idle
// during a gated sweep, is unacceptable). A session with a live runtime entry
// (options.isSessionLive) is additionally protected as defense-in-depth.
export const RESUMABLE_OPEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const RESUMABLE_OPEN_MAX_COUNT = 300;
// Blank scratch sessions (zero user/assistant conversation) are reaped once
// idle this long — see sweepUserOwnedRecord in sweep-row.mjs.
export const BLANK_SCRATCH_MAX_AGE_MS = 60 * 60 * 1000; // 1h

// Sweep-local lifecycle record cache keyed by the session's record stamp
// (log and json, ../session-record.mjs). The sweep decides from top-level
// fields only (owner/status/timestamps plus the conversation count), yet it
// used to read and strictly parse EVERY session transcript on each 5-minute
// pass — measured at 1,198 files / 758MB per pass on one store. A record
// whose stamp is unchanged yields the same verdict, so only changed records
// are read; only the decision fields are kept in the cached record (see the
// summary-repair path, which re-reads).
//
// The records are persisted beside the summary index as well. Held only in
// memory they died with every process, so the first pass after each start
// (five minutes after boot) re-read and parsed the whole store again —
// measured at 2,704 files / 2.4GB: 16.5s of parsing and a 200-470MB
// transient heap spike on every daemon restart. A persisted record is trusted
// under the same fingerprint, so a file that changed while no process was
// running is still parsed again.
const sweepRecordCache = new Map();
const SWEEP_RECORD_CACHE_FILE = 'session-sweep-records.json';
// 4: entries are keyed by record stamp.
const SWEEP_RECORD_CACHE_VERSION = 4;
let sweepRecordCacheDataDir = null;
let sweepRecordCacheDirty = false;
let sweepRecordParses = 0;

// The current data dir's persisted records, loaded once per data dir (a switch
// starts over). An absent, unreadable or older-format file is simply rebuilt.
function syncSweepRecordCache() {
  const dataDir = getPluginData();
  if (sweepRecordCacheDataDir === dataDir) return;
  sweepRecordCacheDataDir = dataDir;
  sweepRecordCache.clear();
  sweepRecordCacheDirty = false;
  let persisted = null;
  try {
    persisted = JSON.parse(readFileSync(join(dataDir, SWEEP_RECORD_CACHE_FILE), 'utf-8'));
  } catch {
    return;
  }
  if (persisted?.version !== SWEEP_RECORD_CACHE_VERSION) return;
  for (const [id, entry] of Object.entries(persisted.entries || {})) {
    if (typeof entry?.stamp === 'string' && typeof entry.record?.doc === 'object' && entry.record.doc !== null) {
      sweepRecordCache.set(id, entry);
    }
  }
}

// The only document fields sweep-row reads (effectiveFields, the closed
// check, the sub-agent retention verdict). Caching the whole top-level document kept
// every session's tool catalogs, schemas and provider state alive — one
// entry per session file, measured at ~290MB of a 470MB daemon heap.
const SWEEP_DOC_FIELDS = [
  'id',
  'closed',
  'closedReason',
  'owner',
  'status',
  'provider',
  'updatedAt',
  'lastHeartbeatAt',
  'createdAt',
  'ownerSessionId',
  'parentSessionId',
  'lastUsedAt',
  'agent',
  'visibility',
  'sessionVisibility',
  'taskOrigin',
];

function conversationCountOf(doc) {
  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  let count = 0;
  for (const message of messages) {
    if (message && (message.role === 'user' || message.role === 'assistant')) count++;
  }
  return count;
}

/** The file holds no data (empty or NUL-filled by a crash); never cached. */
export const SWEEP_RECORD_NO_DATA = Symbol('sweep-record-no-data');

// A legacy json without data, as the sweep's legacy loader reports it.
const NO_DATA_DOC = Object.freeze({});

function loadSweepLegacy(text, sessionId) {
  return holdsNoData(text) ? NO_DATA_DOC : loadLegacySession(text, sessionId);
}

/** `null` when the record could not be read or holds no session of `id`;
 * SWEEP_RECORD_NO_DATA for a legacy json (no log) without data; otherwise the
 * lifecycle record. `stamp`: the record stamp taken just before. */
export function readSweepRecord(id, dir, stamp) {
  syncSweepRecordCache();
  const cached = sweepRecordCache.get(id);
  if (cached && cached.stamp === stamp) return cached.record;
  let outcome;
  try {
    outcome = readSessionRecordSync(dir, id, { loadLegacy: loadSweepLegacy });
  } catch {
    return null;
  }
  // Only a json that is the whole record is no record at all: one beside a
  // log never takes the log with it.
  if (outcome.session === NO_DATA_DOC) return outcome.kind === 'legacy' ? SWEEP_RECORD_NO_DATA : null;
  sweepRecordParses++;
  const full = recordLifecycle(outcome, id);
  if (!full) return null;
  const doc = {};
  for (const field of SWEEP_DOC_FIELDS) {
    if (Object.hasOwn(full.doc, field)) doc[field] = full.doc[field];
  }
  const record = {
    id: full.id,
    closed: full.closed,
    generation: full.generation,
    doc,
    conversationCount: conversationCountOf(full.doc),
  };
  sweepRecordCache.set(id, { stamp, record });
  sweepRecordCacheDirty = true;
  return record;
}

export function pruneSweepRecordCache(liveIds) {
  syncSweepRecordCache();
  for (const id of sweepRecordCache.keys()) {
    if (liveIds.has(id)) continue;
    sweepRecordCache.delete(id);
    sweepRecordCacheDirty = true;
  }
}

/** Writes the records back once a pass has changed them. Best effort: a failed
 *  write only costs the next process start the full read it paid before. */
export function persistSweepRecordCache() {
  if (!sweepRecordCacheDirty) return;
  try {
    writeJsonAtomicSync(
      join(sweepRecordCacheDataDir, SWEEP_RECORD_CACHE_FILE),
      { version: SWEEP_RECORD_CACHE_VERSION, entries: Object.fromEntries(sweepRecordCache) },
      { compact: true, fsync: false }
    );
    sweepRecordCacheDirty = false;
  } catch {
    /* the next pass writes again */
  }
}

/** Test/diagnostic seam: cached records and the files this process parsed. */
export function sweepRecordCacheStats() {
  syncSweepRecordCache();
  return { entries: sweepRecordCache.size, parses: sweepRecordParses };
}
