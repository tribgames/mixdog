// Lead TUI busy-input steering queue — disk mirror of in-memory `pending`
// (same store as manager pending-messages, lead-scoped session key).
import { randomBytes } from 'crypto';
import { join } from 'path';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';
import { updateJsonAtomic } from '../../runtime/shared/atomic-file.mjs';
import { promptContentText } from './queue-helpers.mjs';

const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;

// Serialize this UI process's own steering writes so append→drop→drain keep
// their issue order even though each now waits on the lock asynchronously.
// Cross-process mutual exclusion still comes from the shared lock protocol;
// this chain only orders same-process operations that were previously
// naturally ordered by the synchronous call site.
let _persistChain = Promise.resolve();
function _serialize(task) {
  const run = _persistChain.then(task, task);
  // Never let a rejection poison the chain; each op logs its own error.
  _persistChain = run.catch(() => {});
  return run;
}

function pendingMessagesPath() {
  return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

function tuiSteeringSessionKey(leadSessionId) {
  if (typeof leadSessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(leadSessionId)) return null;
  return `tui_${leadSessionId}`;
}

function newSteeringPersistId() {
  return `ts_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function normalizeTuiSteeringQueueEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text || null;
  }
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.text === 'string' && entry.text.trim()) {
    const text = entry.text.trim();
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    return id ? { id, text } : text;
  }
  return null;
}

function normalizePendingStore(raw) {
  const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
    ? raw.sessions
    : {};
  const storeUpdatedAt = Number(raw?.updatedAt) || Date.now();
  const touchedRaw = raw && typeof raw === 'object' && raw.sessionTouchedAt && typeof raw.sessionTouchedAt === 'object'
    ? raw.sessionTouchedAt
    : {};
  const out = { version: 1, updatedAt: storeUpdatedAt, sessions: {}, sessionTouchedAt: {} };
  for (const [sid, value] of Object.entries(sessions)) {
    if (!/^[A-Za-z0-9_-]+$/.test(sid) || !Array.isArray(value)) continue;
    const q = sid.startsWith('tui_')
      ? value.map(normalizeTuiSteeringQueueEntry).filter(Boolean)
      : value
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof entry.message === 'string') return entry.message;
          return '';
        })
        .filter(Boolean);
    if (q.length > 0) {
      out.sessions[sid] = q;
      const touched = Number(touchedRaw[sid]);
      out.sessionTouchedAt[sid] = Number.isFinite(touched) && touched > 0 ? touched : storeUpdatedAt;
    }
  }
  return out;
}

function touchPendingSessionEntry(next, sessionId, now = Date.now()) {
  if (!next.sessionTouchedAt || typeof next.sessionTouchedAt !== 'object') next.sessionTouchedAt = {};
  next.sessionTouchedAt[sessionId] = now;
}

function entryPersistText(entry) {
  if (!entry) return '';
  const text = typeof entry.text === 'string' && entry.text.trim()
    ? entry.text.trim()
    : promptContentText(entry.content ?? entry.text ?? '').trim();
  return text;
}

function rowMatchesEntry(row, entry) {
  const persistId = entry?.steeringPersistId;
  if (persistId) {
    return Boolean(row && typeof row === 'object' && row.id === persistId);
  }
  const text = entryPersistText(entry);
  if (!text) return false;
  return row === text;
}

function removePersistRow(q, entry) {
  const idx = q.findIndex((row) => rowMatchesEntry(row, entry));
  if (idx >= 0) q.splice(idx, 1);
}

// Consistency-required: a dropped append loses a user's queued steering
// message, so we async-wait for the lock (never try-once). Returns a promise;
// fire-and-forget at call sites is fine — _serialize keeps append/drop/drain
// in issue order and the write never blocks the render loop.
export function appendTuiSteeringPersist(leadSessionId, entry) {
  const text = entryPersistText(entry);
  if (!text) return Promise.resolve();
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve();
  if (!entry.steeringPersistId) entry.steeringPersistId = newSteeringPersistId();
  const record = { id: entry.steeringPersistId, text };
  return _serialize(async () => {
    try {
      await updateJsonAtomic(pendingMessagesPath(), (raw) => {
      const next = normalizePendingStore(raw);
      const q = Array.isArray(next.sessions[key]) ? next.sessions[key] : [];
      q.push(record);
      next.sessions[key] = q;
      const now = Date.now();
      next.updatedAt = now;
      touchPendingSessionEntry(next, key, now);
      return next;
      }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
      try { process.stderr.write(`[tui] steering-queue append failed sessionId=${leadSessionId}: ${err?.message || err}\n`); } catch {}
    }
  });
}

export function dropTuiSteeringPersist(leadSessionId, entries) {
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve();
  const batch = Array.isArray(entries) ? entries : [];
  if (batch.length === 0) return Promise.resolve();
  return _serialize(async () => {
    try {
      await updateJsonAtomic(pendingMessagesPath(), (raw) => {
      const next = normalizePendingStore(raw);
      const q = Array.isArray(next.sessions[key]) ? next.sessions[key].slice() : [];
      if (q.length === 0) return undefined;
      for (const entry of batch) {
        removePersistRow(q, entry);
      }
      if (q.length === 0) {
        delete next.sessions[key];
        if (next.sessionTouchedAt) delete next.sessionTouchedAt[key];
      } else {
        next.sessions[key] = q;
      }
      next.updatedAt = Date.now();
      return next;
      }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
      try { process.stderr.write(`[tui] steering-queue drop failed sessionId=${leadSessionId}: ${err?.message || err}\n`); } catch {}
    }
  });
}

export function flushTuiSteeringPersist() {
  return _persistChain.catch(() => {});
}

function drainedRowToRestore(row) {
  if (typeof row === 'string') {
    return { text: row, steeringPersistId: null };
  }
  if (row && typeof row === 'object' && typeof row.text === 'string') {
    return { text: row.text, steeringPersistId: typeof row.id === 'string' ? row.id : null };
  }
  return null;
}

// Consistency-required (restores queued messages after boot/command). Async
// lock wait, serialized on _persistChain so it never reorders against a
// pending append/drop and never blocks the render loop. Returns a promise of
// the drained rows; call sites await it.
export function drainTuiSteeringPersist(leadSessionId) {
  const key = tuiSteeringSessionKey(leadSessionId);
  if (!key) return Promise.resolve([]);
  return _serialize(async () => {
    let drained = [];
    try {
      await updateJsonAtomic(pendingMessagesPath(), (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[key]) ? next.sessions[key] : [];
        drained = q.map(drainedRowToRestore).filter(Boolean);
        if (drained.length === 0) return undefined;
        delete next.sessions[key];
        if (next.sessionTouchedAt) delete next.sessionTouchedAt[key];
        next.updatedAt = Date.now();
        return next;
      }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
      try { process.stderr.write(`[tui] steering-queue drain failed sessionId=${leadSessionId}: ${err?.message || err}\n`); } catch {}
    }
    return drained;
  });
}
