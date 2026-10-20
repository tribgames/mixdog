export declare const ROUTINE_LIMITS: Readonly<{
  backoffBaseMs: number;
  pauseAfterFailures: number;
  homeQueueLimit: number;
}>;

export declare function routineBackoffRemaining(
  state: { consecutiveFailures?: unknown; lastFailedAt?: unknown } | null | undefined,
  now?: number,
  limits?: typeof ROUTINE_LIMITS
): number;
