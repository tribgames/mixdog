export const TRANSPORT_SCOPE_DISPOSED: 'transport_scope_disposed';
export function forkTransportScope(sessionId: string, label?: string): string;
export function disposeTransportScope(
  scope: string,
  provider?: { releaseTransportScope?(scope: string): void } | null
): void;
