// Recovery authority is a host-owned journal ID, never a client-supplied path.
export type ProjectRecoveryRequest =
  | { action: 'list' }
  | { action: 'inspect'; id: string }
  | { action: 'restore' | 'discard'; id: string; revision: string };

export type ProjectRecoveryFileStatus = 'original' | 'written' | 'restored' | 'external' | 'missing' | 'unavailable';
export interface ProjectRecoverySummary {
  id: string;
  createdAt: number;
  phase: 'interrupted' | 'failed' | 'recovered' | 'completed' | 'active' | 'invalid' | 'retired';
  fileCount: number;
  payloadBytes?: number;
}
export interface ProjectRecoveryDetail extends ProjectRecoverySummary {
  revision: string;
  active: boolean;
  files: Array<{ relPath: string; status: ProjectRecoveryFileStatus; reason?: string }>;
  message?: string;
}
export interface ProjectRecoveryStorage {
  usedRecords: number;
  maxRecords: number;
  unresolvedRecords: number;
  resolvedRecords: number;
  /** Declared before/after payload bytes in valid manifests, not total disk usage. */
  payloadBytes: number;
  unknownSizeRecords: number;
  maxBatchBytes: number;
  maxBatchFiles: number;
}
export interface ProjectRecoveryResponse {
  records: ProjectRecoverySummary[];
  storage?: ProjectRecoveryStorage;
  rootAvailable?: boolean;
  detail?: ProjectRecoveryDetail;
}

export const RECOVERY_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function requiredProjectRecoveryRequest(value: unknown): ProjectRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid recovery request.');
  const input = value as Record<string, unknown>;
  if (input.action === 'list') return { action: 'list' };
  if (typeof input.id !== 'string' || !RECOVERY_ID_PATTERN.test(input.id)) throw new TypeError('Invalid recovery ID.');
  if (input.action === 'inspect') return { action: 'inspect', id: input.id };
  if (
    (input.action === 'restore' || input.action === 'discard') &&
    typeof input.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(input.revision)
  ) {
    return { action: input.action, id: input.id, revision: input.revision };
  }
  throw new TypeError('Invalid recovery action or revision.');
}

// Bounded machine codes also survive Electron's message-only error boundary.
// These are presentation hints only, never restoration or path authority.
export const RECOVERY_ERROR_CODES = [
  'RECOVERY_CHANGED',
  'RECOVERY_BUSY',
  'RECOVERY_CAPACITY',
  'RECOVERY_BATCH_LIMIT',
  'RECOVERY_STORAGE',
  'RECOVERY_NOT_RESTORABLE',
  'RECOVERY_UNAVAILABLE',
  'RECOVERY_MANUAL_INSPECTION',
] as const;
export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number];
export class ProjectRecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.code = code;
    this.name = 'ProjectRecoveryError';
  }
}
export function recoveryFailureCode(error: unknown): RecoveryErrorCode | null {
  const value = error as { code?: unknown; message?: unknown } | null;
  if (typeof value?.code === 'string' && (RECOVERY_ERROR_CODES as readonly string[]).includes(value.code))
    return value.code as RecoveryErrorCode;
  const message = typeof value?.message === 'string' ? value.message : '';
  return RECOVERY_ERROR_CODES.find((code) => message.includes(`${code}: `)) ?? null;
}
export function recoveryFailureRecord(error: unknown): string | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const id = message.slice(message.lastIndexOf('\n[file-recovery] ') + 17);
  return message.includes('\n[file-recovery] ') && RECOVERY_ID_PATTERN.test(id) ? id : null;
}

/** Preserve semantic errors; normalize only known OS storage failures. */
export function recoveryStorageError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE'].includes(String(code))
    ? new ProjectRecoveryError(
        'RECOVERY_STORAGE',
        'Recovery storage is unavailable. Check free space and permissions.',
        { cause: error }
      )
    : error;
}
