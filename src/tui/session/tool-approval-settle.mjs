/**
 * src/tui/session/tool-approval-settle.mjs — how one tool-approval entry ends:
 * the answer its waiter gets, the forwarded answer of a copy, and the outcome
 * record published on the state (`toolApprovalResult`).
 */
import { normalizeHumanResponse } from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import { withdrawDelegatedApproval } from '../../runtime/shared/delegated-approval-host.mjs';

// Settle one entry: drop its timeout, then hand the waiter its answer. The
// resolve stays guarded — a waiter whose caller already went away must never
// take the rest of the queue down with it.
export function settleToolApproval(entry, approved, reason, answers, reply, extra, device = '') {
  if (entry?.timer) clearTimeout(entry.timer);
  const result = { approved, reason };
  if (answers !== undefined) result.answers = answers;
  if (reply !== undefined) result.reply = reply;
  // A human-kind request answers with its canonical response (never a value).
  if (entry?.request?.remember) {
    Object.assign(result, normalizeHumanResponse(entry.request, approved, extra));
    if (device) result.device = device;
  }
  if (extra?.timedOut === true) result.timedOut = true;
  // Settled here: its copy in the top-level chat goes away.
  if (entry?.delegated) {
    withdrawDelegatedApproval(entry.id, { approved, device, ...(extra?.timedOut === true ? { expired: true } : {}) });
  }
  try {
    entry.resolve(result);
  } catch {
    // The requester's resolver must not break settling the queue.
  }
}

/** Hand a copy's answer to the queue that owns the request; false when the
 *  owner had already settled it. */
export function forwardToOwner(entry, approved, reason, device, answers, reply, extra) {
  try {
    return entry.mirror.answer(approved, reason, device, answers, reply, extra) === true;
  } catch {
    return false;
  }
}

/** How the shown entry ended, from its own finish: only an answer from a known
 *  device is attributed; a real timeout says `expired`; any other unattributed
 *  end names nobody (null). */
export function finishedOutcome(id, approved, device, extra) {
  if (device) return { id, approved: approved === true, device: String(device), at: Date.now() };
  if (extra?.timedOut === true) return { id, approved: false, device: '', expired: true, at: Date.now() };
  return null;
}

/** How a copy ended, from the owner's settle: answered from a known device
 *  (who), a real timeout (`expired`), or taken away with no answer
 *  (`withdrawn`: the owner's turn ended, the hand-off copy was removed). */
export function copyOutcome(id, result) {
  const device = String(result?.device || '');
  const at = Date.now();
  if (device) return { id, approved: result.approved === true, device, at };
  if (result?.expired === true) return { id, approved: false, device: '', expired: true, at };
  return { id, approved: false, device: '', withdrawn: true, at };
}
