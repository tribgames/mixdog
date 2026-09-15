import { defaultSessionLaneStore } from './session-lane-store';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import {
  beginSessionReadTrace, reportSessionRead, settleSessionReadTrace,
} from './session-read-diagnostics';

// Coalesce reads only within their interactive deadline. Late frames remain
// usable, but a hung IPC must not capture every subsequent Retry gesture.
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
  let expired = false;
  let timer = 0;
  const deadline = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => {
      expired = true;
      reportSessionRead(sessionId, 'wait-expired', {
        hasLane: defaultSessionLaneStore.get(sessionId) !== null,
      }, traceId);
      resolve(false);
    }, TRANSCRIPT_READ_TIMEOUT_MS);
  });
  const operation = (async () => {
    for (let attempt = 1; attempt <= MAX_SESSION_READ_ATTEMPTS; attempt += 1) {
      if (expired) return false;
      let accepted = false;
      const startedAt = performance.now();
      try {
        accepted = await Promise.resolve(readSession(sessionId, undefined, traceId)) === true;
        if (expired) return false;
        reportSessionRead(sessionId, 'request-result', {
          attempt, accepted, durationMs: performance.now() - startedAt,
          hasLane: defaultSessionLaneStore.get(sessionId) !== null,
        }, traceId);
      } catch {
        if (expired) return false;
        reportSessionRead(sessionId, 'request-failed', {
          attempt, durationMs: performance.now() - startedAt,
        }, traceId);
      }
      if (accepted) {
        if (defaultSessionLaneStore.get(sessionId) === null) {
          try { window.mixdogDesktop?.resyncSessionState?.(sessionId); } catch {
            // A closed bridge remains recoverable through the pane's Retry UI.
          }
        }
        return true;
      }
      if (attempt < MAX_SESSION_READ_ATTEMPTS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    }
    return false;
  })();
  const request = Promise.race([operation, deadline]).finally(() => window.clearTimeout(timer));
  sessionReadsInFlight.set(sessionId, request);
  void request.finally(() => {
    if (sessionReadsInFlight.get(sessionId) === request) sessionReadsInFlight.delete(sessionId);
    settleSessionReadTrace(sessionId, traceId, defaultSessionLaneStore.get(sessionId) !== null);
  });
  return request;
}
