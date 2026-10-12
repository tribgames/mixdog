// worker-index/approval-wait.mjs
// Persists a worker's approval wait (runtime begin/end transitions) into the
// worker index, so processes that read only the stored index — the desktop
// Agents pane — see it. One process can hold several worker-index instances
// over the same file (every runtime's agent tool in the daemon); exactly one
// writer per file answers each transition, so a wait costs one index write on
// begin and one on end.
import { onSessionApprovalWaitChange } from '../../../../runtime/shared/session-approval-wait.mjs';

const writersByFile = new Map(); // file -> writer functions, first answers
let unsubscribe = null;

function persistTransition(sessionId, awaitingUser) {
  for (const writers of writersByFile.values()) writers[0]?.(sessionId, awaitingUser);
}

/** Register `writer(sessionId, awaitingUser)` for `file`; returns the release. */
export function registerApprovalWaitWriter(file, writer) {
  if (!file || typeof writer !== 'function') return () => {};
  const writers = writersByFile.get(file) || [];
  writers.push(writer);
  writersByFile.set(file, writers);
  unsubscribe ??= onSessionApprovalWaitChange(persistTransition);
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
