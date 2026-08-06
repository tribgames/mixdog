// Host-side media resolution shared by the two byte lanes on this machine:
// the Electron `mixdog-media://` protocol and the LAN bridge's /media route.
// Both need a FILE (path + mime), never a base64 payload — that is the whole
// point of moving gallery bytes off the RPC lane.
import type { DesktopBackend } from './backend-api';

export interface MediaFileTarget {
  path: string;
  mime: string;
}

const MEDIA_FILE_TARGET_CACHE_LIMIT = 256;
const mediaFileTargets = new Map<string, MediaFileTarget>();
const targetKey = (assetId: string, variant: string): string => `${variant}:${assetId}`;

export function forgetMediaFileTarget(assetId: string, variant: string): void {
  mediaFileTargets.delete(targetKey(assetId, variant));
}

/** Resolve one asset/rendition to a file, or null when this host cannot
 *  produce it (unknown asset, or no sharp/ffmpeg for the rendition). */
export async function resolveMediaFileTarget(
  host: Pick<DesktopBackend, 'invokeCapability'>,
  assetId: string,
  variant: string,
  options: { generate?: boolean } = {},
): Promise<MediaFileTarget | null> {
  const key = targetKey(assetId, variant);
  const cached = mediaFileTargets.get(key);
  if (cached) {
    mediaFileTargets.delete(key);
    mediaFileTargets.set(key, cached);
    return cached;
  }
  const result = await host.invokeCapability('resolveMediaFile', [assetId, {
    variant,
    ...options,
  }]);
  const file = (result as { value?: unknown } | null)?.value as {
    path?: unknown;
    mime?: unknown;
    available?: unknown;
  } | null;
  if (!file || file.available === false) return null;
  const path = typeof file.path === 'string' ? file.path : '';
  if (!path) return null;
  const target = {
    path,
    mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream',
  };
  mediaFileTargets.set(key, target);
  while (mediaFileTargets.size > MEDIA_FILE_TARGET_CACHE_LIMIT) {
    const oldest = mediaFileTargets.keys().next().value;
    if (!oldest) break;
    mediaFileTargets.delete(oldest);
  }
  return target;
}
