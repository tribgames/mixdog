import { createHash } from 'node:crypto';
import { evictOldest } from '../shared/common';

export function createCaptureImageDedupStore(maxEntries = 64) {
  const digestByTarget = new Map<string, string>();
  return {
    /** Records this frame for the target and reports whether it repeats the
     *  previous one. */
    isRepeat(targetKey: string, imageData: string): boolean {
      if (!targetKey || !imageData) return false;
      const digest = createHash('sha256').update(imageData).digest('hex');
      const repeat = digestByTarget.get(targetKey) === digest;
      digestByTarget.delete(targetKey);
      digestByTarget.set(targetKey, digest);
      evictOldest(digestByTarget, maxEntries);
      return repeat;
    },
    forget(targetKey: string): void {
      digestByTarget.delete(targetKey);
    },
    releasePrefix(prefix: string): void {
      for (const key of digestByTarget.keys()) {
        if (key.startsWith(prefix)) digestByTarget.delete(key);
      }
    },
  };
}
