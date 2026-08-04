import crypto from 'crypto'
import { CACHE_PATH, readJson, writeJson } from './config.mjs'

const DEFAULT_CACHE_STATE = {
  entries: {},
}

// Size bounds on top of TTL expiry so cache.local.json can't grow unbounded.
const MAX_CACHE_ENTRIES = 500
const MAX_CACHE_BYTES = 8 * 1024 * 1024

// Approximate serialized size of ONE entry (never the whole map), so insert and
// evict stay cheap. A running total on the state (`__approxBytes`) lets the byte
// cap be checked without re-serializing every entry on each set.
function approxEntryBytes(key, entry) {
  try { return String(key).length + JSON.stringify(entry).length } catch { return String(key).length }
}
function cacheApproxBytes(state) {
  if (typeof state.__approxBytes === 'number') return state.__approxBytes
  let total = 0
  for (const [k, e] of Object.entries(state.entries)) total += approxEntryBytes(k, e)
  state.__approxBytes = total
  return total
}
function removeCacheEntry(state, key) {
  const e = state.entries[key]
  if (e === undefined) return
  if (typeof state.__approxBytes === 'number') state.__approxBytes -= approxEntryBytes(key, e)
  delete state.entries[key]
}
function evictOldestCacheEntry(state) {
  let oldestKey = null
  let oldestAt = Infinity
  for (const [k, e] of Object.entries(state.entries)) {
    const at = e?.cachedAt ?? 0
    if (at < oldestAt) { oldestAt = at; oldestKey = k }
  }
  if (oldestKey == null) return false
  removeCacheEntry(state, oldestKey)
  return true
}
// Best-effort: evict oldest entries until under both the count and byte caps.
function enforceCacheSizeBounds(state) {
  try {
    while (Object.keys(state.entries).length > MAX_CACHE_ENTRIES) {
      if (!evictOldestCacheEntry(state)) break
    }
    while (cacheApproxBytes(state) > MAX_CACHE_BYTES && Object.keys(state.entries).length > 0) {
      if (!evictOldestCacheEntry(state)) break
    }
  } catch { /* size bounding is best-effort */ }
}

const FLUSH_DELAY_MS = 5000

let cacheDirty = false
let cacheFlushTimer = null
let activeCacheState = null
let lastCacheFlushWarnAt = 0

function nowMs() {
  return Date.now()
}

// 5s debounce so a single search invocation that touches the cache multiple
// times (lookup + insert + prune) coalesces into one writeJson roundtrip.
// Without this, callers like crawl/batch that don't explicitly flush would
// either spam fsync (immediate write per mutation) or silently drop dirty
// state on crash (bare dirty flag).
function scheduleCacheFlush(state) {
  cacheDirty = true
  activeCacheState = state
  if (cacheFlushTimer) return
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null
    flushCacheState()
  }, FLUSH_DELAY_MS)
  if (cacheFlushTimer.unref) cacheFlushTimer.unref()
}

function flushCacheState() {
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer)
    cacheFlushTimer = null
  }
  if (cacheDirty && activeCacheState) {
    try {
      writeJson(CACHE_PATH, activeCacheState)
      cacheDirty = false
    } catch (err) {
      // Cache state is best-effort. Windows AV/indexer can hold the
      // destination open. Keep the dirty state and retry quietly.
      const now = Date.now()
      if (now - lastCacheFlushWarnAt > 60000) {
        lastCacheFlushWarnAt = now
        process.stderr.write(`[search-cache] flushCacheState delayed: ${err?.code || err?.message || err}\n`)
      }
      if (!cacheFlushTimer) {
        cacheFlushTimer = setTimeout(() => {
          cacheFlushTimer = null
          flushCacheState()
        }, FLUSH_DELAY_MS * 2)
        if (cacheFlushTimer.unref) cacheFlushTimer.unref()
      }
    }
  }
}

process.on('exit', flushCacheState)

export { flushCacheState }

let _instance = null

export function loadCacheState() {
  if (_instance) return _instance
  const state = readJson(CACHE_PATH, DEFAULT_CACHE_STATE)
  if (!state.entries || typeof state.entries !== 'object') {
    state.entries = {}
  }
  _instance = state
  activeCacheState = state
  pruneExpiredEntries(state)
  cacheApproxBytes(state)
  enforceCacheSizeBounds(state)
  return state
}

export function buildCacheKey(namespace, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
  return `${namespace}:${hash}`
}

export function getCachedEntry(state, key) {
  const entry = state.entries[key]
  if (!entry) return null
  if (entry.expiresAt && entry.expiresAt <= nowMs()) {
    removeCacheEntry(state, key)
    scheduleCacheFlush(state)
    return null
  }
  return entry
}

export function setCachedEntry(state, key, payload, ttlMs) {
  const cachedAt = nowMs()
  if (state.entries[key] !== undefined) removeCacheEntry(state, key)
  const entry = { cachedAt, expiresAt: cachedAt + ttlMs, payload }
  state.entries[key] = entry
  if (typeof state.__approxBytes === 'number') state.__approxBytes += approxEntryBytes(key, entry)
  enforceCacheSizeBounds(state)
  scheduleCacheFlush(state)
  return state.entries[key]
}

export function buildCacheMeta(entry, hit) {
  return {
    hit,
    cachedAt: entry ? new Date(entry.cachedAt).toISOString() : null,
    expiresAt: entry ? new Date(entry.expiresAt).toISOString() : null,
  }
}

function pruneExpiredEntries(state) {
  const current = nowMs()
  let dirty = false
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry?.expiresAt && entry.expiresAt <= current) {
      removeCacheEntry(state, key)
      dirty = true
    }
  }
  if (dirty) {
    scheduleCacheFlush(state)
  }
}
