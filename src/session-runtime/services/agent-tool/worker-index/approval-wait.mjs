// worker-index/approval-wait.mjs
// Persists a worker's approval wait (runtime begin/end transitions) into the
// worker index, so processes that read only the stored index — the desktop
// Agents pane — see it. One process can hold several worker-index instances
// over the same file (every runtime's agent tool in the daemon); they share one
// row store per file, and exactly one writer per file answers each transition,
// so a wait costs one index write on begin and one on end.
//
// `awaitingUser` is a field of its own on the row: only conditional field
// updates (applyAwaitingUser, re-run on the locked document) set or clear it,
// fenced by session id and turn. Whole-row writes keep whatever the current
// row holds and drop it once the row settles (settleAwaitingUser).
import {
  currentSessionApprovalWaits,
  onSessionApprovalWaitChange,
} from '../../../../runtime/shared/session-approval-wait.mjs';
import { stampMs } from '../helpers.mjs';
import { isTerminalWorkerStatus } from '../worker-rows.mjs';

const writersByFile = new Map(); // file -> writer functions, first answers
let unsubscribe = null;

function withAwaitingUser(row, value) {
  if (value ? row.awaitingUser === value : !('awaitingUser' in row)) return row;
  const { awaitingUser: _prior, ...rest } = row;
  return value ? { ...rest, awaitingUser: value } : rest;
}

/** `row` as a whole-row write may leave it: the flag `current` (the value the
 *  row holds before the write) survives unless the row settled. Returns `row`
 *  itself when nothing changes. */
export function settleAwaitingUser(row, current) {
  return withAwaitingUser(row, current === 'approval' && !isTerminalWorkerStatus(row.status) ? 'approval' : null);
}

/** The flag `fence` wants on `row`, or undefined when the update is not for
 *  it: another session, or a turn that started after the transition's turn. */
function fencedAwaitingUser(row, { sessionId, awaitingUser, turnAt }) {
  if (row.sessionId !== sessionId) return undefined;
  if (turnAt > 0 && stampMs(row.turnStartedAt) > turnAt) return undefined;
  return awaitingUser === 'approval' && !isTerminalWorkerStatus(row.status) ? 'approval' : null;
}

/** Whether applyAwaitingUser(fence) would change any of `rows`. */
export function awaitingUserWouldChange(rows, fence) {
  return rows.some((row) => {
    const wanted = fencedAwaitingUser(row, fence);
    return wanted !== undefined && withAwaitingUser(row, wanted) !== row;
  });
}

/** Field update: only `awaitingUser` of the fenced rows, nothing else. */
export function applyAwaitingUser(byKey, fence) {
  for (const [key, row] of byKey) {
    const wanted = fencedAwaitingUser(row, fence);
    if (wanted === undefined) continue;
    const next = withAwaitingUser(row, wanted);
    if (next !== row) byKey.set(key, next);
  }
}

/** Field update: drop every flag `isStale(row)` holds for. */
export function clearAwaitingUser(byKey, isStale) {
  for (const [key, row] of byKey) {
    if (row.awaitingUser && isStale(row)) byKey.set(key, withAwaitingUser(row, null));
  }
}

function persistTransition(sessionId, awaitingUser, meta) {
  for (const writers of writersByFile.values()) writers[0]?.(sessionId, awaitingUser, meta);
}

/** Register `writer(sessionId, awaitingUser, { turnAt })` for `file`; returns
 *  the release. The first writer of a file also receives the waits already
 *  open, so a wait that began before any index existed is not lost. */
export function registerApprovalWaitWriter(file, writer) {
  if (!file || typeof writer !== 'function') return () => {};
  const writers = writersByFile.get(file) || [];
  writers.push(writer);
  writersByFile.set(file, writers);
  unsubscribe ??= onSessionApprovalWaitChange(persistTransition);
  if (writers.length === 1) {
    for (const { sessionId, ...meta } of currentSessionApprovalWaits()) writer(sessionId, 'approval', meta);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (writersByFile.get(file) || []).filter((entry) => entry !== writer);
    if (remaining.length) writersByFile.set(file, remaining);
    else writersByFile.delete(file);
    if (writersByFile.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
