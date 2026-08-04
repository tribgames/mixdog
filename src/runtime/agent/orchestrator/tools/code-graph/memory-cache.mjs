// In-memory (TTL + LRU + runtime-byte budget) code-graph cache. Wraps the
// shared codeGraphCache Map from code-graph-state.mjs with LRU touch/set and
// eviction. Extracted verbatim from code-graph.mjs.
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  codeGraphCache as _codeGraphCache,
} from '../code-graph-state.mjs';
import {
  CODE_GRAPH_MEMORY_MAX_ENTRIES,
  CODE_GRAPH_MEMORY_MAX_SOURCE_BYTES,
} from './constants.mjs';
import {
  _estimateGraphRuntimeCacheBytes,
  _clearGraphRuntimeCaches,
} from './graph-model.mjs';

export function _touchCodeGraphCache(graphCwd) {
  const key = _canonicalGraphCwd(graphCwd);
  const entry = _codeGraphCache.get(key);
  if (!entry) return;
  _codeGraphCache.delete(key);
  entry.lastAccess = Date.now();
  _codeGraphCache.set(key, entry);
}

export function _setCodeGraphCache(graphCwd, entry) {
  const key = _canonicalGraphCwd(graphCwd);
  const payload = { ...entry, lastAccess: Date.now() };
  if (_codeGraphCache.has(key)) _codeGraphCache.delete(key);
  _codeGraphCache.set(key, payload);
  _pruneCodeGraphMemoryCache();
}

export function _pruneCodeGraphMemoryCache(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : CODE_GRAPH_MEMORY_MAX_ENTRIES;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : CODE_GRAPH_MEMORY_MAX_SOURCE_BYTES;
  const rows = [..._codeGraphCache.entries()].map(([cwd, entry]) => ({
    cwd,
    entry,
    lastAccess: Number(entry?.lastAccess || entry?.ts || 0),
    runtimeBytes: _estimateGraphRuntimeCacheBytes(entry?.graph),
  }));
  rows.sort((a, b) => (a.lastAccess - b.lastAccess) || String(a.cwd).localeCompare(String(b.cwd)));
  const evicted = [];
  let totalRuntimeBytes = rows.reduce((sum, row) => sum + row.runtimeBytes, 0);
  for (const row of rows) {
    if (totalRuntimeBytes <= maxBytes) break;
    if (!row.entry?.graph || row.runtimeBytes <= 0) continue;
    const freed = row.runtimeBytes;
    _clearGraphRuntimeCaches(row.entry.graph);
    row.runtimeBytes = 0;
    totalRuntimeBytes -= freed;
    evicted.push({ cwd: row.cwd, reason: 'max-bytes-runtime', freed });
  }
  while (_codeGraphCache.size > maxEntries) {
    const oldestKey = _codeGraphCache.keys().next().value;
    if (!oldestKey) break;
    _codeGraphCache.delete(oldestKey);
    evicted.push({ cwd: oldestKey, reason: 'max-entries' });
  }
  return { evicted, totalRuntimeBytes: Math.max(0, totalRuntimeBytes), entries: _codeGraphCache.size };
}
