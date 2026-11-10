// session-address.mjs — the durable address of an addressed runtime.
//
// A daemon-addressed runtime (reserved or loaded by the session service) owns
// exactly ONE conversation id for its whole life. `reservedSessionId` is the
// one-shot "materialize me" token and is cleared on first adoption; the
// address outlives it. The address is bound at reservation and at
// resume/load-on-demand, and thereafter:
//   - "no live session object" never permits creating another conversation;
//   - an OPEN durable record under the address is resumed (same id);
//   - a CLOSED record makes the runtime terminal (never recreated/overwritten);
//   - a missing/unreadable record is an explicit failure (never minted).
// Admission (open → closing → terminal) is the canonical-close fence.
import { SessionClosedError } from '../runtime/agent/orchestrator/session/manager/session-errors.mjs';

export class SessionAddressError extends Error {
  constructor(message, sessionId = null) {
    super(message);
    this.name = 'SessionAddressError';
    this.sessionId = sessionId;
  }
}

export function initSessionAddress(rt) {
  rt.addressedSessionId = null;
  rt.admission = 'open';
  rt.lifecycleGeneration = 0;
}

/** Bind (or re-confirm) the durable address. A second, different id is a
 *  re-key attempt and is refused. */
export function bindSessionAddress(rt, id) {
  const next = String(id || '').trim();
  if (!next) throw new SessionAddressError('session address is required');
  if (rt.addressedSessionId && rt.addressedSessionId !== next) {
    throw new SessionAddressError(
      `runtime is addressed as ${rt.addressedSessionId}; it cannot be re-keyed to ${next} (use a new session entry)`,
      rt.addressedSessionId
    );
  }
  rt.addressedSessionId = next;
  return next;
}

export const isAddressedTo = (rt, id) => !!rt.addressedSessionId && rt.addressedSessionId === String(id || '');

/** Refuse an explicit transition that would move an addressed runtime to
 *  another conversation. */
export function assertNotAddressed(rt, operation) {
  if (rt.addressedSessionId) {
    throw new SessionAddressError(
      `${operation} would re-key addressed session ${rt.addressedSessionId}; create a new session entry instead`,
      rt.addressedSessionId
    );
  }
}

export const isAdmissionOpen = (rt) => !rt.admission || rt.admission === 'open';

export function assertAdmissionOpen(rt) {
  if (isAdmissionOpen(rt)) return;
  throw new SessionClosedError(rt.addressedSessionId || 'unknown', 'session is closed to new work', 'canonical-close');
}

/** Resume may only reopen the conversation this runtime is addressed as. */
export function assertResumeTarget(rt, id) {
  assertAdmissionOpen(rt);
  if (rt.addressedSessionId && rt.addressedSessionId !== String(id || '')) {
    throw new SessionAddressError(
      `runtime is addressed as ${rt.addressedSessionId}; it cannot resume ${id} (use a new session entry)`,
      rt.addressedSessionId
    );
  }
}

/** Fence admission before the manager close can cancel owned shells. */
export function beginCanonicalClose(rt, sessionId) {
  const previous = rt.admission || 'open';
  if (!rt.addressedSessionId) rt.addressedSessionId = String(sessionId);
  rt.admission = 'closing';
  return previous;
}

/** Settle the fence: terminal after a durable close, restored otherwise. */
export function finishCanonicalClose(rt, previous, closed) {
  if (closed) markTerminal(rt);
  else rt.admission = previous;
}

export function markTerminal(rt) {
  if (rt.admission !== 'terminal') {
    rt.admission = 'terminal';
    rt.lifecycleGeneration = (rt.lifecycleGeneration || 0) + 1;
  }
}

/** Lifecycle view used by the notification bus; null = not an owner here. */
export function ownerLifecycle(rt, sessionId) {
  if (!isAddressedTo(rt, sessionId)) return null;
  return { state: rt.admission || 'open', generation: rt.lifecycleGeneration || 0 };
}

/** The durable record under the address: open | closed | missing. */
export function addressedRecord(rt, mgr) {
  let record = null;
  try {
    record = mgr.getSession(rt.addressedSessionId);
  } catch {
    record = null;
  }
  if (!record) return { state: 'missing', record: null };
  if (record.closed === true || record.status === 'closed') return { state: 'closed', record };
  return { state: 'open', record };
}

export function closedAddressError(rt) {
  markTerminal(rt);
  return new SessionClosedError(rt.addressedSessionId, 'durable record is closed', 'canonical-close');
}

export function missingAddressError(rt) {
  return new SessionAddressError(
    `session ${rt.addressedSessionId} record is missing or unreadable; refusing to create another conversation`,
    rt.addressedSessionId
  );
}
