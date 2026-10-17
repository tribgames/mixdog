// Short-lived media asset ids for files that are not gallery assets (project
// file previews). The RPC that authorized the file mints an unguessable id for
// it; the relay media lane resolves that id back to the file. Authorization
// stays where it was decided, and the lane never sees a path from the network.
// A lease records the folder its file was authorized within and that file's
// identity, so the lane opens it again through openAuthorizedFile and serves
// only the very file that was authorized, at an allowed real location.
import { randomUUID } from 'node:crypto';

const MAX_LEASES = 256;
const LEASE_TTL_MS = 60 * 60 * 1000;

/** Where a leased file was authorized: its folder and its dev/ino. */
export interface MediaLeaseAuthorization {
  within: string;
  identity: { dev: bigint; ino: bigint };
}

interface Lease extends MediaLeaseAuthorization {
  path: string;
  mime: string;
  expiresAt: number;
}

const leases = new Map<string, Lease>();

export function leaseMediaFile(
  path: string,
  mime: string,
  authorized: MediaLeaseAuthorization,
  now = Date.now()
): string {
  const assetId = randomUUID();
  leases.set(assetId, {
    path,
    mime,
    within: authorized.within,
    identity: { ...authorized.identity },
    expiresAt: now + LEASE_TTL_MS,
  });
  while (leases.size > MAX_LEASES) {
    const oldest = leases.keys().next().value as string;
    leases.delete(oldest);
  }
  return assetId;
}

export function leasedMediaFile(
  assetId: string,
  now = Date.now()
): ({ path: string; mime: string } & MediaLeaseAuthorization) | null {
  const lease = leases.get(assetId);
  if (!lease) return null;
  if (lease.expiresAt <= now) {
    leases.delete(assetId);
    return null;
  }
  return { path: lease.path, mime: lease.mime, within: lease.within, identity: lease.identity };
}
