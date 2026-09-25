/**
 * Electron-free session resource policy shared by the host and its behavioral
 * tests. Stale recapture drops only action-bound targets; terminal lifecycle
 * cleanup drops every capture-owned resource and its session preference.
 */
/** Pixels: a frame point names whatever sits there now, so it ages fast. */
export const MAX_COMPUTER_OBSERVATION_AGE_MS = 60_000;
/** Semantic refs are re-resolved against the live element at dispatch, so the
 *  observed window scope that authorizes them outlasts an agent's usual
 *  one-to-five-minute think between commands. */
export const MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS = 300_000;

export function isFreshComputerObservation(
  observedAt: number,
  now: number,
  maximumAgeMs = MAX_COMPUTER_OBSERVATION_AGE_MS
): boolean {
  return Number.isFinite(observedAt) && Number.isFinite(now) && now >= observedAt && now - observedAt <= maximumAgeMs;
}

export function resolveFreshComputerObservationScope<TScope extends { observedAt: number }>(
  sessionId: string,
  scopesBySession: Map<string, TScope>,
  now: number
): { scope?: TScope; expired: boolean } {
  const scope = scopesBySession.get(sessionId);
  if (!scope || isFreshComputerObservation(scope.observedAt, now, MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS)) {
    return { scope, expired: false };
  }
  scopesBySession.delete(sessionId);
  return { expired: true };
}

export function invalidateComputerActionTargets<TFrame, TElement>(
  sessionId: string,
  stores: {
    framesBySession: Map<string, TFrame>;
    elementTargetsBySession: Map<string, TElement>;
  }
): void {
  stores.framesBySession.delete(sessionId);
  stores.elementTargetsBySession.delete(sessionId);
}

export function rememberLatestComputerFrame<TFrame>(
  sessionId: string,
  frameId: string,
  frame: TFrame,
  framesBySession: Map<string, Map<string, TFrame>>
): void {
  framesBySession.set(sessionId, new Map([[frameId, frame]]));
}

export function invalidateComputerWorkerGeneration<TFrame, TElement, TObserved, TCapture>(
  sessionId: string,
  stores: {
    framesBySession: Map<string, TFrame>;
    elementTargetsBySession: Map<string, TElement>;
    observedWindowBySession: Map<string, TObserved>;
    lastCaptureBySession: Map<string, TCapture>;
  }
): void {
  invalidateComputerActionTargets(sessionId, stores);
  stores.observedWindowBySession.delete(sessionId);
  stores.lastCaptureBySession.delete(sessionId);
}

export function releaseComputerSessionResources<TFrame, TElement, TObserved, TCapture>(
  sessionId: string,
  stores: {
    framesBySession: Map<string, TFrame>;
    elementTargetsBySession: Map<string, TElement>;
    observedWindowBySession: Map<string, TObserved>;
    lastCaptureBySession: Map<string, TCapture>;
  },
  releaseCaptureSession?: (releasedSessionId: string) => void
): void {
  invalidateComputerWorkerGeneration(sessionId, stores);
  releaseCaptureSession?.(sessionId);
}
