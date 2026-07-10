// Code-graph tuning constants + cache-file name/regex patterns. Extracted
// verbatim from code-graph.mjs so the build/cache/search modules can share
// one source of truth. Behavior-identical: same env vars, same defaults.

export const CODE_GRAPH_TTL_MS = 30_000;
export const CODE_GRAPH_MAX_FILES = 10_000;
// A cold-process disk hit may deserialize only this much JSON on the main
// thread. Larger entries still validate/rebuild inside the Worker.
export const CODE_GRAPH_FAST_PATH_MAX_BYTES = 8 * 1024 * 1024;
export const CODE_GRAPH_WORKER_TIMEOUT_MS = 120_000;
// Timeout for the native mixdog-graph binary child process (spawned per graph build).
export const CODE_GRAPH_BINARY_TIMEOUT_MS = Math.max(1000, Number(process.env.MIXDOG_CODE_GRAPH_BINARY_TIMEOUT_MS) || 20000);
// Legacy single-file cache. Kept as a constant for the one-shot migration
// path; new writes go into the per-cwd directory layout below.
export const CODE_GRAPH_DISK_FILE = 'code-graph-cache.json';
// Per-cwd cache: <data>/code-graph-cache/manifest.json + <hash>.json per
// indexed root. Avoids the unbounded single-file blob (observed >50 MB on
// long-running workspaces) that had to be JSON.parsed in full on every
// fresh process startup.
export const CODE_GRAPH_DISK_DIR = 'code-graph-cache';
export const CODE_GRAPH_DISK_MAX_ENTRIES = 24;
export const CODE_GRAPH_DISK_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_CACHE_MAX_MB) || 80) * 1024 * 1024),
);
// Reap writeFileAtomicSync debris only after this age (see _sweepCodeGraphCacheDir).
// Younger .tmp files may belong to an in-flight persist still holding the sibling .lock;
// DEFAULT_LOCK_TIMEOUT_MS is 8s — 120s is a safe margin for large graph JSON writes.
export const ORPHAN_TMP_MIN_AGE_MS = 120_000;
export const RE_CACHE_TMP = /^\.[0-9a-f]{16}\.json\.[0-9a-f]{24}\.tmp$/i;
export const RE_MANIFEST_TMP = /^\.manifest\.json\.[0-9a-f]{24}\.tmp$/i;
export const RE_CACHE_LOCK = /^[0-9a-f]{16}\.json\.lock$/i;
export const CODE_GRAPH_MEMORY_MAX_ENTRIES = Math.max(
  1,
  Math.floor(Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_ENTRIES) || 6),
);
export const CODE_GRAPH_MEMORY_MAX_SOURCE_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_MB) || 48) * 1024 * 1024),
);
// Bump when the per-symbol record SHAPE changes (e.g. adding endLine). The
// version is folded into the cache signature so graphs built by an older
// binary/schema (symbols without a finite endLine) no longer match and are
// rebuilt instead of served — otherwise a stale cache would feed endLine-less
// symbols and silently defeat body-span containment in _nearestEnclosingSymbol.
export const SYMBOL_SCHEMA_VERSION = 'sym-range-v3-rustimports';
