const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

function entryBytes(key, vector) {
  // Vector storage is exact (Float32Array.byteLength). UTF-16 key bytes plus a
  // small fixed allowance bound Map/string/object overhead conservatively.
  return vector.byteLength + String(key).length * 2 + 64
}

/**
 * LRU cache specialized for embedding vectors.
 *
 * Worker results are semantically float32 but arrive over structured clone as
 * JS number[]. Keeping 1,000 such arrays stores every component as a wider JS
 * Number. Compact once on insertion; callers still receive normal arrays, so
 * the embedding provider's public contract and PG serialization stay intact.
 */
export function createCompactVectorCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES))
  const byteLimit = Math.max(1024, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES))
  const entries = new Map()
  let bytes = 0

  function remove(key) {
    const current = entries.get(key)
    if (!current) return false
    entries.delete(key)
    bytes = Math.max(0, bytes - current.bytes)
    return true
  }

  function trim() {
    while (entries.size > entryLimit || bytes > byteLimit) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  function set(key, input) {
    if (!Array.isArray(input) && !ArrayBuffer.isView(input)) {
      throw new TypeError('embedding cache vector must be an array or typed array')
    }
    const vector = input instanceof Float32Array ? input.slice() : Float32Array.from(input)
    remove(key)
    const size = entryBytes(key, vector)
    // A single vector larger than the whole budget is useful to its caller but
    // must not permanently violate the cache bound.
    if (size > byteLimit) return false
    entries.set(key, { vector, bytes: size })
    bytes += size
    trim()
    return true
  }

  function get(key) {
    const current = entries.get(key)
    if (!current) return null
    entries.delete(key)
    entries.set(key, current)
    return current.vector
  }

  function clear() {
    entries.clear()
    bytes = 0
  }

  function snapshot() {
    return {
      entries: entries.size,
      bytes,
      maxEntries: entryLimit,
      maxBytes: byteLimit,
    }
  }

  return {
    get,
    set,
    has: (key) => entries.has(key),
    clear,
    snapshot,
  }
}
