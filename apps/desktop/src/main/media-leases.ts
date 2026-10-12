// Short-lived media asset ids for files that are not gallery assets (project
// file previews). The RPC that authorized the file mints an unguessable id for
// it; the relay media lane resolves that id back to the file. Authorization
// stays where it was decided, and the lane never sees a path from the network.
import { randomUUID } from 'node:crypto';

const MAX_LEASES = 256;
const LEASE_TTL_MS = 60 * 60 * 1000;

interface Lease {
  path: string;
  mime: string;
  expiresAt: number;
}

const leases = new Map<string, Lease>();

export function leaseMediaFile(path: string, mime: string, now = Date.now()): string {
  const assetId = randomUUID();
  leases.set(assetId, { path, mime, expiresAt: now + LEASE_TTL_MS });
  while (leases.size > MAX_LEASES) {
    const oldest = leases.keys().next().value as string;
    leases.delete(oldest);
  }
  return assetId;
}

export function leasedMediaFile(assetId: string, now = Date.now()): { path: string; mime: string } | null {
  const lease = leases.get(assetId);
  if (!lease) return null;
  if (lease.expiresAt <= now) {
    leases.delete(assetId);
    return null;
  }
  return { path: lease.path, mime: lease.mime };
}
