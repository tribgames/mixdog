import { statSync } from 'node:fs';
import { rawContentCacheSet } from './cache-layers.mjs';
import { sameFileVersion } from './file-version.mjs';

// `before` is an owned version captured BEFORE the fresh read. A failed
// post-read stat is uncertainty, never evidence that the bytes are stable.
// Keep the current invocation's observation; do not retry or relabel it.
export function publishRawContentAfterRead(fullPath, before, rawBuf, readStat = statSync) {
  if (!before || !Buffer.isBuffer(rawBuf) || rawBuf.length !== before.size) return;
  let after;
  try {
    after = readStat(fullPath);
  } catch {
    return;
  }
  if (sameFileVersion(before, after)) rawContentCacheSet(fullPath, before, rawBuf);
}
