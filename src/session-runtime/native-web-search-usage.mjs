// Per-session sink for usage spent by native web-search sends. The search runs
// as its own provider send under a derived session id, so the main stream
// never reports it; a turn's caller opts in with `onNativeWebSearchUsage` and
// receives the same delta shape `onUsageDelta` carries.
//
// Keyed by the owning session id, not async-local state: tools can execute
// from stream callbacks whose async context belongs to a pooled transport
// connection, not to the ask that is waiting on them.
//
// Each registration is its own entry that only its own release removes, so
// overlapping turns on one session id never restore or drop each other. The
// session lock serializes turns, so the most recent live entry belongs to the
// turn that is running; callers register once their turn owns the session.
import { usageDeltaEvent } from '../runtime/agent/orchestrator/session/loop/usage.mjs';

const entriesBySession = new Map();

/** Adds an owned sink entry for `sessionId`; the returned release removes exactly that entry. */
export function registerNativeWebSearchUsageSink(sessionId, sink) {
  if (typeof sink !== 'function' || !sessionId) return () => {};
  const entry = { sink };
  let entries = entriesBySession.get(sessionId);
  if (!entries) {
    entries = [];
    entriesBySession.set(sessionId, entries);
  }
  entries.push(entry);
  return () => {
    const live = entriesBySession.get(sessionId);
    const index = live ? live.indexOf(entry) : -1;
    if (index === -1) return;
    live.splice(index, 1);
    if (live.length === 0) entriesBySession.delete(sessionId);
  };
}

export function reportNativeWebSearchUsage({ ownerSessionId, sessionId, requestedModel, model, usage }) {
  const entries = entriesBySession.get(ownerSessionId);
  const sink = entries?.[entries.length - 1]?.sink;
  if (!sink || !usage) return;
  try {
    const pending = sink({
      ...usageDeltaEvent({ sessionId, iterationIndex: 0, requestedModel, model, usage }),
      source: 'native_web_search',
      agentRole: 'web-search',
    });
    if (typeof pending?.then === 'function') pending.then(undefined, () => {});
  } catch {
    /* telemetry must never fail the search */
  }
}
