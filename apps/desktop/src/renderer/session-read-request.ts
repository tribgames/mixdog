import { defaultSessionLaneStore } from './session-lane-store';
import {
  beginSessionReadTrace, reportSessionRead, settleSessionReadTrace,
} from './session-read-diagnostics';

// The diagnostics observe this existing single-flight/retry policy; they do
// not cancel, replace, or replay a pending read.
const sessionReadsInFlight = new Map<string, Promise<boolean>>();
const MAX_SESSION_READ_ATTEMPTS = 3;

export function requestSessionRead(
  sessionId: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  const existing = defaultSessionLaneStore.get(sessionId);
  if (!refresh && existing && Array.isArray(existing.items) && existing.items.length > 0) {
    return Promise.resolve(true);
  }
  const inFlight = sessionReadsInFlight.get(sessionId);
  if (inFlight) {
    reportSessionRead(sessionId, 'request-joined');
    return inFlight;
  }
  const readSession = window.mixdogDesktop?.prefetchSession;
  if (typeof readSession !== 'function') return Promise.resolve(false);
  defaultSessionLaneStore.start();
  const traceId = beginSessionReadTrace(sessionId);
  const request = (async () => {
    for (let attempt = 1; attempt <= MAX_SESSION_READ_ATTEMPTS; attempt += 1) {
      let accepted = false;
      const startedAt = performance.now();
      try {
        accepted = await Promise.resolve(readSession(sessionId, undefined, traceId)) === true;
        reportSessionRead(sessionId, 'request-result', {
          attempt, accepted, durationMs: performance.now() - startedAt,
          hasLane: defaultSessionLaneStore.get(sessionId) !== null,
        }, traceId);
      } catch {
        reportSessionRead(sessionId, 'request-failed', {
          attempt, durationMs: performance.now() - startedAt,
        }, traceId);
      }
      if (accepted) return true;
      if (attempt < MAX_SESSION_READ_ATTEMPTS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    }
    return false;
  })();
  sessionReadsInFlight.set(sessionId, request);
  void request.finally(() => {
    if (sessionReadsInFlight.get(sessionId) === request) sessionReadsInFlight.delete(sessionId);
    settleSessionReadTrace(sessionId, traceId, defaultSessionLaneStore.get(sessionId) !== null);
  });
  return request;
}
