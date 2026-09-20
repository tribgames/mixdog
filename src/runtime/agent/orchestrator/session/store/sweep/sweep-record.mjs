// sweep/sweep-record.mjs
// What the stale-session sweep reads per record and the bounds it decides
// with: the fingerprint-cached lifecycle record, the linked-agent retention
// rule, and the idle / retention / blank-scratch thresholds.
import { readFileSync } from 'node:fs';
import { isAgentOwner } from '../../../agent-owner.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../../lifecycle-scan.mjs';
import { sessionPath } from '../paths-heartbeat.mjs';
import { probePath, PROBE_ABSENT } from '../fs-probe.mjs';

export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes idle — aligned with Anthropic 5m messages tier and OpenAI in-memory cache window
export const AGENT_TERMINAL_STATUSES = new Set(['idle', 'done', 'error']);
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

// Sweep-local lifecycle record cache keyed by the session file's fingerprint.
// The sweep decides from top-level fields only (owner/status/timestamps plus
// the conversation count), yet it used to read and strictly parse EVERY
// session transcript on each 5-minute pass — measured at 1,198 files / 758MB
// per pass on one store. A file whose mtime and size are unchanged yields the
// same verdict, so only changed files are parsed; the transcript itself is
// dropped from the cached record (see the summary-repair path, which re-reads).
const sweepRecordCache = new Map();

function conversationCountOf(doc) {
  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  let count = 0;
  for (const message of messages) {
    if (message && (message.role === 'user' || message.role === 'assistant')) count++;
  }
  return count;
}

/** `null` when the file could not be read; otherwise the lifecycle record
 * (possibly LIFECYCLE_SCAN_CONFLICT, which is never cached). */
export function readSweepRecord(id, jsonPath, probe) {
  const cached = sweepRecordCache.get(id);
  if (cached && cached.mtimeMs === probe.mtimeMs && cached.size === probe.size) return cached.record;
  let raw = null;
  try {
    raw = readFileSync(jsonPath, 'utf-8');
  } catch {
    return null;
  }
  const full = readTopLevelLifecycleRecord(raw);
  if (isLifecycleUnreadable(full)) return full;
  const doc = { ...full.doc };
  delete doc.messages;
  const record = {
    id: full.id,
    closed: full.closed,
    generation: full.generation,
    doc,
    conversationCount: conversationCountOf(full.doc),
  };
  sweepRecordCache.set(id, { mtimeMs: probe.mtimeMs, size: probe.size, record });
  return record;
}

export function pruneSweepRecordCache(liveIds) {
  for (const id of sweepRecordCache.keys()) {
    if (!liveIds.has(id)) sweepRecordCache.delete(id);
  }
}

/** Child-agent transcripts share their visible parent's retention boundary.
 * Presence (including a tombstone or unreadable file) preserves the child;
 * only proven parent absence releases it to ordinary cleanup. */
export function retainedLinkedAgent(session) {
  if (!session || !isAgentOwner(session)) return false;
  const parentId = String(session.ownerSessionId || session.parentSessionId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(parentId) || parentId === session.id) return false;
  return probePath(sessionPath(parentId)).state !== PROBE_ABSENT;
}
