export type NativeCaptureBackend = 'print_window' | 'wgc';
export type CaptureBackend = 'app_owned' | 'composited' | NativeCaptureBackend;
export interface CaptureCleanup {
  status: 'confirmed' | 'failed' | 'unconfirmed' | 'unknown';
  cancellation?: 'settled' | 'unconfirmed' | 'failed';
}
export interface CaptureAttempt {
  backend: CaptureBackend;
  scope: 'target' | 'owner';
  status: 'captured' | 'unavailable' | 'failed';
  elapsed_ms: number;
  code?: string;
  cleanup?: CaptureCleanup;
}

// Reserve time for cancellation and native resource release before worker kill.
export const NATIVE_CAPTURE_TIMEOUT_MS = 2_000;
export const NATIVE_CAPTURE_WORK_MS = NATIVE_CAPTURE_TIMEOUT_MS - 500;

export function captureCleanup(value: unknown): CaptureCleanup | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (!['confirmed', 'failed', 'unconfirmed', 'unknown'].includes(String(row.status))) return;
  return {
    status: row.status as CaptureCleanup['status'],
    ...(['settled', 'unconfirmed', 'failed'].includes(String(row.cancellation))
      ? { cancellation: row.cancellation as CaptureCleanup['cancellation'] } : {}),
  };
}

/** Persist only bounded categories and timings, never images or error messages. */
export function captureAttempts(value: unknown): CaptureAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((row) => {
    if (!row || !['app_owned', 'composited', 'print_window', 'wgc'].includes(row.backend)
      || !['target', 'owner'].includes(row.scope)
      || !['captured', 'unavailable', 'failed'].includes(row.status)
      || typeof row.elapsed_ms !== 'number' || !Number.isFinite(row.elapsed_ms) || row.elapsed_ms < 0) return [];
    const cleanup = captureCleanup(row.cleanup);
    return [{
      backend: row.backend, scope: row.scope, status: row.status, elapsed_ms: row.elapsed_ms,
      ...(typeof row.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(row.code) ? { code: row.code } : {}),
      ...(cleanup ? { cleanup } : {}),
    }];
  });
}

/** Attach evidence without changing cancellation/stale-target error identity. */
export function attachCaptureAttempts(error: unknown, attempts: CaptureAttempt[]): unknown {
  if (error instanceof Error) Object.assign(error, { captureAttempts: captureAttempts(attempts) });
  return error;
}

export function captureAttemptsFromError(error: unknown): CaptureAttempt[] {
  return error instanceof Error
    ? captureAttempts((error as Error & { captureAttempts?: unknown }).captureAttempts) : [];
}
