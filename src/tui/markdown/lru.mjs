/**
 * Map-backed LRU touch shared by the per-stream markdown caches: insert or
 * refresh `key` as the most recent entry, then evict the oldest entries until
 * at most `max` remain.
 */
export function touchLru(cache, key, value, max) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
