// Per-session sink for usage spent by native web-search sends. The search runs
// as its own provider send under a derived session id, so the main stream
// never reports it; a turn's caller opts in with `onNativeWebSearchUsage` and
// receives the same delta shape `onUsageDelta` carries.
//
// Keyed by the owning session id, not async-local state: tools can execute
// from stream callbacks whose async context belongs to a pooled transport
// connection, not to the ask that is waiting on them.
import { usageDeltaEvent } from '../runtime/agent/orchestrator/session/loop/usage.mjs';

const sinks = new Map();

/** Installs `sink` for `sessionId` and returns the function that restores the prior one. */
export function registerNativeWebSearchUsageSink(sessionId, sink) {
  if (typeof sink !== 'function' || !sessionId) return () => {};
  const prior = sinks.get(sessionId);
  sinks.set(sessionId, sink);
  return () => {
    if (sinks.get(sessionId) !== sink) return;
    if (prior) sinks.set(sessionId, prior);
    else sinks.delete(sessionId);
  };
}

export function reportNativeWebSearchUsage({ ownerSessionId, sessionId, requestedModel, model, usage }) {
  const sink = sinks.get(ownerSessionId);
  if (!sink || !usage) return;
  try {
    sink({
      ...usageDeltaEvent({ sessionId, iterationIndex: 0, requestedModel, model, usage }),
      source: 'native_web_search',
      agentRole: 'web-search',
    });
  } catch {
    /* telemetry must never fail the search */
  }
}
