// In-memory (TTL + LRU + runtime-byte budget) code-graph cache. Wraps the
// shared codeGraphCache Map from code-graph-state.mjs with LRU touch/set and
// eviction. Extracted verbatim from code-graph.mjs.
import {
  canonicalGraphCwd as _canonicalGraphCwd,
  codeGraphCache as _codeGraphCache,
} from '../code-graph-state.mjs';
import {
  CODE_GRAPH_MEMORY_MAX_ENTRIES,
  CODE_GRAPH_MEMORY_MAX_BYTES,
} from './constants.mjs';
import {
  _estimateGraphRetainedBytes,
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
    : CODE_GRAPH_MEMORY_MAX_BYTES;
  const rows = [..._codeGraphCache.entries()].map(([cwd, entry]) => ({
    cwd,
    entry,
    lastAccess: Number(entry?.lastAccess || entry?.ts || 0),
    retainedBytes: _estimateGraphRetainedBytes(entry?.graph),
  }));
  rows.sort((a, b) => (a.lastAccess - b.lastAccess) || String(a.cwd).localeCompare(String(b.cwd)));
  const evicted = [];
  let totalRetainedBytes = rows.reduce((sum, row) => sum + row.retainedBytes, 0);
  for (const row of rows) {
    if (totalRetainedBytes <= maxBytes) break;
    if (!row.entry?.graph) continue;
    const before = row.retainedBytes;
    _clearGraphRuntimeCaches(row.entry.graph);
    row.retainedBytes = _estimateGraphRetainedBytes(row.entry.graph);
    const freed = Math.max(0, before - row.retainedBytes);
    totalRetainedBytes -= freed;
    if (freed > 0) evicted.push({ cwd: row.cwd, reason: 'max-bytes-runtime', freed });
  }
  for (const row of rows) {
    if (totalRetainedBytes <= maxBytes) break;
    if (!_codeGraphCache.has(row.cwd)) continue;
    _codeGraphCache.delete(row.cwd);
    totalRetainedBytes -= row.retainedBytes;
    evicted.push({ cwd: row.cwd, reason: 'max-bytes-graph', freed: row.retainedBytes });
  }
  while (_codeGraphCache.size > maxEntries) {
    const oldestKey = _codeGraphCache.keys().next().value;
    if (!oldestKey) break;
    _codeGraphCache.delete(oldestKey);
    const row = rows.find((candidate) => candidate.cwd === oldestKey);
    const freed = row?.retainedBytes || 0;
    totalRetainedBytes -= freed;
    evicted.push({ cwd: oldestKey, reason: 'max-entries', freed });
  }
  return {
    evicted,
    totalRetainedBytes: Math.max(0, totalRetainedBytes),
    entries: _codeGraphCache.size,
  };
}
