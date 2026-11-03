// Row-level predicates shared by the terminal-reaper modules.
import { stampMs } from '../helpers.mjs';
import { ACTIVE_STAGES } from '../tool-def.mjs';
import { resolveAgentTerminalReapMs } from '../../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { isTerminalWorkerStatus, tagTombstoneKey } from '../worker-rows.mjs';

/** Latest proof of life on the session record itself. createdAt is included
 * as the last resort so a brand-new session that has not been stamped yet is
 * never mistaken for the reaped one that used to own its tag. */
export function sessionActivityAt(session) {
  let latest = 0;
  for (const value of [session?.updatedAt, session?.finishedAt, session?.lastUsedAt, session?.createdAt]) {
    const parsed = stampMs(value);
    if (parsed > latest) latest = parsed;
  }
  return latest;
}

export function isTerminalRow(row) {
  return isTerminalWorkerStatus(row.status || row.stage);
}

// A settled row stays indexed this long after it finished, and in any case until
// its own continuation (reap) window has ended.
export const SETTLED_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Whether a settled record has aged out of the index: past the retention
 *  floor and past its continuation deadline (`reapAt` when stamped, else the
 *  provider's resolved window). `record` is a worker row or a session: both
 *  carry the same stamp fields, so pruning a row and admitting a session scan
 *  one rule over its latest activity stamp. Decided by stamps alone.
 *  `getConfig` is called only when the provider window is needed: loading
 *  config costs file reads and credential probes on every list pulse. */
export function pastSettledRetention(getConfig, record, now = Date.now()) {
  const settledAtMs = sessionActivityAt(record);
  if (!(settledAtMs > 0) || now - settledAtMs < SETTLED_ROW_RETENTION_MS) return false;
  const stamped = stampMs(record.reapAt);
  if (stamped > 0) return now >= stamped;
  return now >= settledAtMs + resolveAgentTerminalReapMs(getConfig(), record.provider);
}

/** In-memory proof that a session is still in use (a running or just-resumed
 *  turn, a queued delivery, a controller not yet aborted). Never loads a
 *  session record. */
export function sessionHasLiveWork(mgr, sessionId) {
  if (mgr.isSessionTurnInFlight?.(sessionId) === true || mgr.hasPendingMessages?.(sessionId) === true) return true;
  const runtime = mgr.getSessionRuntime?.(sessionId) || null;
  if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return true;
  const stage = runtime?.stage;
  return Boolean(stage && ACTIVE_STAGES.has(stage));
}

export function insertTombstone(tombstonesByKey, priorityTombstoneKeys, tombstone) {
  const key = tagTombstoneKey(tombstone);
  tombstonesByKey.set(key, tombstone);
  priorityTombstoneKeys.add(key);
}
