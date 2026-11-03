export const SESSION_GRANT_TTL_MS: number;
export const MAX_SESSION_GRANTS: number;
export interface SessionGrantKey {
  sessionId: string;
  agentId: string;
  action: string;
  mark?: string;
}
export interface SessionGrants {
  grant(key: SessionGrantKey): boolean;
  has(key: SessionGrantKey): boolean;
  end(sessionId: string): void;
}
export function createSessionGrants(options?: { now?: () => number; ttlMs?: number; maxEntries?: number }): SessionGrants;
