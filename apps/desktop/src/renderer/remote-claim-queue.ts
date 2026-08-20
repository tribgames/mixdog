import type { DesktopRemoteClientClaim } from "../shared/contract";

export const REMOTE_CLAIM_FALLBACK_LIFETIME_MS = 295_000;

export function normalizeRemoteClientClaim(
  value: Partial<DesktopRemoteClientClaim> | null | undefined,
  now = Date.now(),
): DesktopRemoteClientClaim | null {
  const claimId = String(value?.claimId || "").slice(0, 1_024);
  if (!claimId) return null;

  const rawExpiresAt = Number(value?.expiresAt);
  if (Number.isFinite(rawExpiresAt) && rawExpiresAt <= now) return null;
  const expiresAt = Number.isFinite(rawExpiresAt)
    ? Math.min(rawExpiresAt, now + REMOTE_CLAIM_FALLBACK_LIFETIME_MS)
    : now + REMOTE_CLAIM_FALLBACK_LIFETIME_MS;

  return {
    claimId,
    clientId: String(value?.clientId || claimId).slice(0, 80),
    name: String(value?.name || "").slice(0, 80),
    platform: String(value?.platform || "").slice(0, 80),
    browser: String(value?.browser || "").slice(0, 80),
    expiresAt,
  };
}

export function pruneRemoteClientClaims(
  claims: readonly DesktopRemoteClientClaim[],
  now = Date.now(),
): DesktopRemoteClientClaim[] {
  return claims.filter((claim) => claim.expiresAt > now);
}

export function enqueueRemoteClientClaim(
  claims: readonly DesktopRemoteClientClaim[],
  incoming: DesktopRemoteClientClaim,
  now = Date.now(),
): DesktopRemoteClientClaim[] {
  const next: DesktopRemoteClientClaim[] = [];
  let insertionIndex = -1;

  for (const claim of claims) {
    if (claim.expiresAt <= now) continue;
    const sameRequest = claim.claimId === incoming.claimId;
    const sameClient = Boolean(incoming.clientId) && claim.clientId === incoming.clientId;
    if (sameRequest || sameClient) {
      if (insertionIndex < 0) insertionIndex = next.length;
      continue;
    }
    next.push(claim);
  }

  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, incoming);
  return next;
}
