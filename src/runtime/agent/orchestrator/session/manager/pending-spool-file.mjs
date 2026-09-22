// The shared cross-process pending-message spool file: where it lives, which
// session ids and rows may enter it, the single locked transaction shape every
// mutation uses, and the per-session serialization of those transactions.
// Nothing here decides WHAT to queue — only how the file is read, written and
// kept well-formed.
import { join } from 'node:path';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import {
  COMPLETION_NOTIFICATION_KIND,
  completionExecutionId,
  normalizePersistedEntry,
  pendingMessageId,
} from './pending-message-entry.mjs';

const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
export const _pendingPersistTails = new Map();

export function pendingMessagesPath() {
  return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

// Single spool transaction shape: every mutation of the shared file is locked,
// compact and non-fsync; `extra` only ever relaxes the lock timeout.
export function updateSpool(mutate, extra = null) {
  return updateJsonAtomic(pendingMessagesPath(), mutate, {
    compact: true,
    lock: true,
    mode: PENDING_MESSAGES_MODE,
    fsync: false,
    ...extra,
  });
}

// Publish a session's queue inside a spool transaction. An emptied queue drops
// the session row AND its touch stamp instead of persisting an empty array.
export function setSpoolQueue(next, sessionId, kept) {
  if (kept.length > 0) {
    next.sessions[sessionId] = kept;
    return;
  }
  delete next.sessions[sessionId];
  if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
}

// Serialize one session's spool operations: the op becomes this session's tail
// and removes itself once settled (never clobbering a newer tail).
export function chainSpoolTail(sessionId, operation, onSettled = null) {
  _pendingPersistTails.set(sessionId, operation);
  operation
    .finally(() => {
      if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
      onSettled?.();
    })
    .catch(() => {});
  return operation;
}

export function pendingWarn(message) {
  try {
    process.stderr.write(message);
  } catch {
    /* best-effort */
  }
}

export function isValidPendingSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

export function isTuiSteeringPendingKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('tui_');
}

function normalizeTuiSteeringQueueEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text || null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const rawText = [entry.text, entry.message, entry.content].find((value) => typeof value === 'string') ?? '';
  if (rawText.trim()) {
    const text = rawText.trim();
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id) return text;
    const normalized = {
      id,
      text,
      message: text,
      enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
    };
    if (entry.notificationKind !== COMPLETION_NOTIFICATION_KIND) return normalized;
    const executionId = completionExecutionId(entry);
    return { ...normalized, notificationKind: COMPLETION_NOTIFICATION_KIND, ...(executionId ? { executionId } : {}) };
  }
  return null;
}

export function normalizePendingStore(raw) {
  const sessions =
    raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  const storeUpdatedAt = Number(raw?.updatedAt) || Date.now();
  const touchedRaw =
    raw && typeof raw === 'object' && raw.sessionTouchedAt && typeof raw.sessionTouchedAt === 'object'
      ? raw.sessionTouchedAt
      : {};
  const out = { version: 1, updatedAt: storeUpdatedAt, sessions: {}, sessionTouchedAt: {} };
  for (const [sid, value] of Object.entries(sessions)) {
    if (!isValidPendingSessionId(sid) || !Array.isArray(value)) continue;
    // Persisted rows are canonical {id, …} objects (persistPendingMessages
    // normalizes at write time); anything else is dropped, not migrated.
    const q = isTuiSteeringPendingKey(sid)
      ? value.map(normalizeTuiSteeringQueueEntry).filter(Boolean)
      : value
          .filter((entry) => entry && typeof entry === 'object' && pendingMessageId(entry))
          .map((entry) => normalizePersistedEntry(entry))
          .filter(Boolean);
    if (q.length > 0) {
      out.sessions[sid] = q;
      const touched = Number(touchedRaw[sid]);
      out.sessionTouchedAt[sid] = Number.isFinite(touched) && touched > 0 ? touched : storeUpdatedAt;
    }
  }
  return out;
}

export function touchPendingSessionEntry(next, sessionId, now = Date.now()) {
  if (!next.sessionTouchedAt || typeof next.sessionTouchedAt !== 'object') next.sessionTouchedAt = {};
  next.sessionTouchedAt[sessionId] = now;
}
