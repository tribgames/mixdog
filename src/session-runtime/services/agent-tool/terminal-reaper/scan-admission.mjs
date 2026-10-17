// Session-scan admission: whether a scan may (re)index a session, and how a
// terminal session's frozen stamps are re-emitted onto its row.
import { clean, stampMs } from '../helpers.mjs';
import { isTerminalWorkerStatus } from '../worker-rows.mjs';
import { ACTIVE_STAGES } from '../tool-def.mjs';
import { sessionActivityAt } from './row-helpers.mjs';

export function createScanAdmission({ mgr, index, tombstoneBlocksScan }) {
  const { readWorkerRows, upsertWorkerSessionDeferred } = index;

  function scanSessionIsTerminal(session) {
    if (!session) return false;
    if (session.closed === true) return true;
    if (!isTerminalWorkerStatus(clean(session.status) || 'idle')) return false;
    const runtime = mgr.getSessionRuntime?.(clean(session.id)) || null;
    if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return false;
    const stage = clean(runtime?.stage);
    return !(stage && ACTIVE_STAGES.has(stage));
  }

  /** Extra fields for a scan/rebind upsert of an already-terminal session. The
   * default row build stamps updatedAt = now and clears reapAt, which restarts
   * the lease from the read instead of from the work: a terminal session owns
   * its frozen stamps, which are kept as-is with no reap deadline. Returns null for
   * running/active sessions so they keep the normal (now-based) behavior. */
  function terminalScanExtra(session) {
    if (!scanSessionIsTerminal(session)) return null;
    const terminalAtMs = sessionActivityAt(session);
    // A stamp-free session cannot prove when its grace started; leave it to the
    // normal path rather than inventing an elapsed deadline.
    if (!(terminalAtMs > 0)) return null;
    const stamp = new Date(terminalAtMs).toISOString();
    const sessionId = clean(session?.id);
    const existing = readWorkerRows().find((row) => clean(row.sessionId) === sessionId) || null;
    const finishedMs = stampMs(session?.finishedAt) || stampMs(existing?.finishedAt);
    return {
      // Stamps are re-emitted as ISO so a numeric session stamp cannot leak an
      // unparseable value into the row store.
      updatedAt: stamp,
      finishedAt: finishedMs > 0 ? new Date(finishedMs).toISOString() : stamp,
      reapAt: null,
    };
  }

  // Shared session-scan admission: returns false when the scan must not
  // resurrect this session, otherwise indexes it (terminal sessions with their
  // own stamps).
  function scanUpsertSession(session, tag, tombstones) {
    if (tombstoneBlocksScan(session, tag, tombstones)) return false;
    const extra = terminalScanExtra(session);
    upsertWorkerSessionDeferred(session, tag, extra || {});
    return true;
  }

  return { scanUpsertSession };
}
