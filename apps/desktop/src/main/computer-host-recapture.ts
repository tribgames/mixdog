const RECAPTURE_REQUIRED_CODES = [
  'computer_foreground_available_recapture_required',
  'computer_target_available_recapture_required',
] as const;

const FAILED_RECAPTURE_OBSERVATION_FIELDS = new Set([
  'ok',
  'action',
  'code',
  'error',
  'window_id',
  'requested_window_id',
  'capture_target_reason',
  'pixel_status',
  'pixel_unavailable',
  'accessibility_status',
  'accessibility_error',
]);

function failedRecaptureObservation(
  observation: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(observation)
      .filter(([field]) => FAILED_RECAPTURE_OBSERVATION_FIELDS.has(field)),
  );
}

export function recaptureRequirementCode(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : String(value || '');
  const normalized = message.startsWith('Error: ') ? message.slice(7) : message;
  return RECAPTURE_REQUIRED_CODES.find((code) =>
    normalized === code || normalized.startsWith(`${code}:`));
}

export function isFreshRecaptureObservation(
  observation: Record<string, unknown> | undefined,
  expectedWindowId = '',
): boolean {
  if (observation?.ok !== true || observation.action !== 'capture') return false;
  const targetWindowId = String(
    observation.requested_window_id
    || observation.window_id
    || '',
  );
  if (!targetWindowId) return false;
  return !expectedWindowId || targetWindowId === expectedWindowId;
}

export function buildRecaptureRequiredPayload(
  action: string,
  error: unknown,
  observation?: Record<string, unknown>,
  expectedWindowId = '',
): Record<string, unknown> | undefined {
  const message = error instanceof Error ? error.message : String(error || '');
  const code = recaptureRequirementCode(message);
  if (!code) return undefined;
  const freshObservation = isFreshRecaptureObservation(observation, expectedWindowId);
  const reportedObservation = freshObservation
    ? observation
    : observation?.ok !== true && observation
      ? failedRecaptureObservation(observation)
      : undefined;
  return {
    ok: false,
    action,
    code,
    error: message,
    verdict: {
      decision: 'escalate',
      recommended: freshObservation ? 'retry_fresh_action' : 'recapture',
    },
    recovery: {
      next: freshObservation ? 'retry_from_observation' : 'capture',
      guidance: freshObservation
        ? 'Review the fresh observation and issue a new action; the stale mutation was not dispatched.'
        : 'The stale mutation was not dispatched and a fresh observation was unavailable; capture the exact target again.',
    },
    ...(reportedObservation ? { observation: reportedObservation } : {}),
  };
}
