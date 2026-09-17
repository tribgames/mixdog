// Bound retained UTF-16 keys and result text as well as entry count.
export const TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export function setBoundedTextCacheEntry(
  map,
  key,
  entry,
  { maxEntries, maxBytes = TEXT_CACHE_MAX_BYTES, onEvict = null }
) {
  const bytes = (key, value) => (key.length + value.content.length) * 2;
  const drop = (key) => {
    if (map.delete(key)) onEvict?.(key);
  };
  drop(key);
  const incomingBytes = bytes(key, entry);
  if (maxEntries <= 0 || incomingBytes > maxBytes) return false;
  let retainedBytes = incomingBytes;
  for (const [storedKey, stored] of map) retainedBytes += bytes(storedKey, stored);
  while (map.size >= maxEntries || retainedBytes > maxBytes) {
    const oldest = map.keys().next().value;
    retainedBytes -= bytes(oldest, map.get(oldest));
    drop(oldest);
  }
  map.set(key, entry);
  return true;
}
