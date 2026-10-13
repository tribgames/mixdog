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
}
export interface ProjectRecoveryDetail extends ProjectRecoverySummary {
  revision: string;
  active: boolean;
  files: Array<{ relPath: string; status: ProjectRecoveryFileStatus; reason?: string }>;
  message?: string;
}
export interface ProjectRecoveryResponse {
  records: ProjectRecoverySummary[];
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
