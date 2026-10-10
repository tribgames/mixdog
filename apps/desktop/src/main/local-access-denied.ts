// Explicit authority refusal, distinct from lookup/transport/IO uncertainty.
// The code survives the existing desktop-service error envelope; instanceof
// alone cannot recognize a denial reconstructed on the other side of the RPC.
const DENIED = 'MIXDOG_LOCAL_ACCESS_DENIED';

export class LocalAccessDeniedError extends Error {
  readonly code = DENIED;
}

export function isLocalAccessDenied(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === DENIED;
}
