// Explicit authority refusal, distinct from lookup/transport/IO uncertainty.
// The code survives the existing desktop-service error envelope; instanceof
// alone cannot recognize a denial reconstructed on the other side of the RPC.
import { PROJECT_UNAVAILABLE, SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';

const DENIED = 'MIXDOG_LOCAL_ACCESS_DENIED';
// A denial may name its specific reason as its code; each is still a denial.
const DENIAL_CODES: ReadonlySet<unknown> = new Set([DENIED, SELECTED_FILE_GRANT_UNAVAILABLE, PROJECT_UNAVAILABLE]);

export class LocalAccessDeniedError extends Error {
  readonly code: string;
  constructor(message: string, code: string = DENIED) {
    super(message);
    this.code = code;
  }
}

export function isLocalAccessDenied(error: unknown): boolean {
  return !!error && typeof error === 'object' && DENIAL_CODES.has((error as { code?: unknown }).code);
}
