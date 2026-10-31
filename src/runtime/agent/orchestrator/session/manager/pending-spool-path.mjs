// Where the cross-process pending-message spool lives and how a session's touch
// stamp is recorded in it. Kept free of the queue machinery so the TUI steering
// mirror shares the exact same file without loading the runtime queue.
import { join } from 'node:path';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';

export const PENDING_MESSAGES_MODE = 0o600;

// Layout: one file (and one lock) per pending key under `session-pending/`.
// A key is an orchestrator session id or a `tui_<lead session id>` steering
// bucket, so operations on different sessions never share a lock.
const PENDING_SHARD_DIR_NAME = 'session-pending';
const LEGACY_PENDING_FILE_NAME = 'session-pending-messages.json';

export function pendingShardDir() {
  return join(resolvePluginData(), PENDING_SHARD_DIR_NAME);
}

export function pendingMessagesPath(sessionId) {
  return join(pendingShardDir(), `${sessionId}.json`);
}

// The pre-sharding global spool; only the one-time migration reads it.
export function legacyPendingMessagesPath() {
  return join(resolvePluginData(), LEGACY_PENDING_FILE_NAME);
}

export function touchPendingSessionEntry(next, sessionId, now = Date.now()) {
  if (!next.sessionTouchedAt || typeof next.sessionTouchedAt !== 'object') next.sessionTouchedAt = {};
  next.sessionTouchedAt[sessionId] = now;
}
