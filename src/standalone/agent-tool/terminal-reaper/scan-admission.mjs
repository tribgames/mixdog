// Session-scan admission: whether a scan may (re)index a session, and how a
// terminal session's frozen stamps translate into the reap deadline that the
// scan then settles through the timers.
import { agentTagOf, clean, stampMs } from '../helpers.mjs';
import { isTerminalWorkerStatus } from '../worker-rows.mjs';
import { ACTIVE_STAGES } from '../tool-def.mjs';
import { resolveAgentTerminalReapMs } from '../../../session-runtime/config-helpers.mjs';
import { sessionActivityAt } from './row-helpers.mjs';

export function createScanAdmission({ cfgMod, mgr, index, tombstoneBlocksScan, timers }) {
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
   * its frozen stamps, and its deadline is derived from them. Returns null for
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
    const reapMs = resolveAgentTerminalReapMs(
      cfgMod.loadConfig(),
      clean(existing?.provider) || clean(session?.provider)
    );
    // An existing lease is authoritative: a read must never extend or reset it.
    const existingReapMs = stampMs(existing?.reapAt);
    let reapAt = null;
    if (existingReapMs > 0) reapAt = new Date(existingReapMs).toISOString();
    else if (reapMs != null) reapAt = new Date(terminalAtMs + reapMs).toISOString();
    const finishedMs = stampMs(session?.finishedAt) || stampMs(existing?.finishedAt);
    return {
      // Stamps are re-emitted as ISO so a numeric session stamp cannot leak an
      // unparseable value into the row store.
      updatedAt: stamp,
      finishedAt: finishedMs > 0 ? new Date(finishedMs).toISOString() : stamp,
      reapAt,
    };
  }

  // Shared session-scan admission: returns false when the scan must not
  // resurrect this session, otherwise indexes it (terminal sessions with their
  // own stamps) and records any terminal deadline for settlement.
  function scanUpsertSession(session, tag, tombstones, pendingTerminal) {
    if (tombstoneBlocksScan(session, tag, tombstones)) return false;
    const extra = terminalScanExtra(session);
    upsertWorkerSessionDeferred(session, tag, extra || {});
    if (extra?.reapAt) {
      pendingTerminal.push({
        tag: agentTagOf(session) || clean(tag),
        sessionId: clean(session.id),
        reapAt: extra.reapAt,
      });
    }
    return true;
  }

  /** Arm (or immediately run) the reap for rows a scan just (re)indexed. An
   * already-elapsed deadline is reaped now instead of buying a new window. */
  function settleScannedTerminalRows(pendingTerminal) {
    if (!pendingTerminal.length) return;
    const now = Date.now();
    for (const row of pendingTerminal) {
      const deadline = stampMs(row.reapAt);
      if (!deadline) continue;
      // reapTerminalRow -> tombstoneTerminalSession flushes the deferred upsert
      // first, so the row it matches on is the one this scan just wrote.
      if (deadline <= now) timers.reapTerminalRow(row);
      else if (!timers.isArmedFor(row.sessionId, row.reapAt)) timers.schedulePersistedReap(row);
    }
  }

  return { scanUpsertSession, settleScannedTerminalRows };
}
