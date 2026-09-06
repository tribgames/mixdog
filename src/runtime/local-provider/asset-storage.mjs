import { mkdirSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCAL_ASSET_DISK_HEADROOM_BYTES = 1024 ** 3;

export function localProviderDiskStatus(path) {
  let candidate = path;
  while (true) {
    try {
      const stats = statfsSync(candidate);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      return { availableBytes: Number.isFinite(availableBytes) ? availableBytes : null };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return { availableBytes: null };
      candidate = parent;
    }
  }
}

export function ensureDiskSpace(path, requiredBytes) {
  mkdirSync(path, { recursive: true });
  const { availableBytes } = localProviderDiskStatus(path);
  if (availableBytes !== null && availableBytes < requiredBytes + LOCAL_ASSET_DISK_HEADROOM_BYTES) {
    throw new Error(`[local-provider] not enough free disk space: requires ${requiredBytes + LOCAL_ASSET_DISK_HEADROOM_BYTES} bytes`);
  }
}

export function partialAssetBytes(destination, size) {
  try {
    const stat = statSync(`${destination}.part`);
    return stat.isFile() && stat.size <= size ? stat.size : 0;
  } catch {
    return 0;
  }
}
