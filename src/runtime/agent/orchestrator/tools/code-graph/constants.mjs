// Code-graph tuning constants + cache-file name/regex patterns. One shared
// source of truth for the build/cache/search modules.

export const CODE_GRAPH_TTL_MS = 30_000;
export const CODE_GRAPH_MAX_FILES = 10_000;
// A cold-process disk hit may deserialize only this much JSON on the main
// thread. Larger entries still validate/rebuild inside the Worker.
export const CODE_GRAPH_FAST_PATH_MAX_BYTES = 8 * 1024 * 1024;
export const CODE_GRAPH_WORKER_TIMEOUT_MS = 120_000;
// Timeout for the native mixdog-graph binary child process (spawned per graph build).
export const CODE_GRAPH_BINARY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MIXDOG_CODE_GRAPH_BINARY_TIMEOUT_MS) || 20000
);
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
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_CACHE_MAX_MB) || 80) * 1024 * 1024)
);
// Resident size of the in-memory mirror of those disk entries. The entry-count
// cap above bounds the DISK set; it left MEMORY unbounded, because one indexed
// monorepo root can serialize to several MB and 24 of them simply stayed
// resident. Every entry is re-loadable from disk, so an evicted one costs a
// single JSON.parse on its next lookup.
export const CODE_GRAPH_DISK_MEMORY_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_DISK_MEMORY_MAX_MB) || 8) * 1024 * 1024)
);
// Reap writeFileAtomicSync debris only after this age (see _sweepCodeGraphCacheDir).
// Younger .tmp files may belong to an in-flight persist still holding the sibling .lock;
// DEFAULT_LOCK_TIMEOUT_MS is 8s — 120s is a safe margin for large graph JSON writes.
export const ORPHAN_TMP_MIN_AGE_MS = 120_000;
export const RE_CACHE_TMP = /^\.[0-9a-f]{16}\.json\.[0-9a-f]{24}\.tmp$/i;
export const RE_MANIFEST_TMP = /^\.manifest\.json\.[0-9a-f]{24}\.tmp$/i;
export const RE_CACHE_LOCK = /^[0-9a-f]{16}\.json\.lock$/i;
// Same debris, for the `<hash>.calls.json` call-site sidecar written beside
// each entry (atomic writer temp name: `.<basename>.<24hex>.tmp`).
export const RE_CALLS_CACHE_TMP = /^\.[0-9a-f]{16}\.calls\.json\.[0-9a-f]{24}\.tmp$/i;
export const RE_CALLS_CACHE_LOCK = /^[0-9a-f]{16}\.calls\.json\.lock$/i;
export const CODE_GRAPH_MEMORY_MAX_ENTRIES = Math.max(
  1,
  Math.floor(Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_ENTRIES) || 6)
);
// Total retained graph memory, including nodes, symbols, indexes and source
// caches. The previous source-cache-only accounting left the much larger base
// graph unbounded across the six-entry LRU.
export const CODE_GRAPH_MEMORY_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  Math.floor((Number(process.env.MIXDOG_CODE_GRAPH_MEMORY_MAX_MB) || 48) * 1024 * 1024)
);
// Bump when the per-symbol record SHAPE changes (e.g. adding endLine). The
// version is folded into the cache signature so graphs built by an older
// binary/schema (symbols without a finite endLine) no longer match and are
// rebuilt instead of served — otherwise a stale cache would feed endLine-less
// symbols and silently defeat body-span containment in _nearestEnclosingSymbol.
//
// v2 record: {name, kind, startLine, endLine, startCol, endCol, exported?,
// sig?, parent?} with ONE unified `kind` vocabulary for every language. A
// pre-v2 payload carries per-language kinds ('binding', 'record', 'object', …)
// and no parent/sig/exported, so it must be rebuilt rather than rendered.
export const SYMBOL_SCHEMA_VERSION = 'sym-record-v2-unified-kinds';

// ── unified symbol-kind vocabulary (native record v2) ──────────────────────
// The Rust extractor maps every per-language kind onto exactly one of these
// (`--langs` publishes the per-language `kinds:{old:new}` table). This is the
// ONLY kind vocabulary the JS side knows: no legacy tokens (object, record,
// contract, union, mixin, binding, arrow, generator, local-function, …) and no
// language-specific special cases.
export const SYMBOL_KINDS = new Set([
  'module',
  'namespace',
  'package',
  'class',
  'struct',
  'interface',
  'trait',
  'enum',
  'enumMember',
  'type',
  'function',
  'method',
  'constructor',
  'field',
  'property',
  'variable',
  'constant',
  'macro',
  'event',
  'protocol',
  'impl',
]);

// Kinds whose outline children are MEMBERS of the symbol: `callees` of a type
// reports what its methods call, and the outline nests those children under it.
export const CONTAINER_SYMBOL_KINDS = new Set([
  'module',
  'namespace',
  'package',
  'class',
  'struct',
  'interface',
  'trait',
  'enum',
  'protocol',
  'impl',
]);

// Kinds that own a body a position can sit INSIDE — the enclosing-symbol
// lookup prefers these over a container when both cover the same line.
export const FUNCTION_LIKE_SYMBOL_KINDS = new Set(['function', 'method', 'constructor']);

// Languages the native extractor emits `symbols`/`calls` for (`--langs`:
// extract=true). A graph whose files are ALL outside this set legitimately has
// no symbols; one INSIDE it with no symbols anywhere means the binary could not
// extract, which is a capability failure, not an empty answer.
export const EXTRACTION_SYMBOL_LANGS = new Set([
  'javascript',
  'typescript',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'ruby',
  'php',
  'swift',
  'c',
  'cpp',
  'scala',
  'bash',
  'lua',
  'dart',
  'objc',
  'elixir',
  'zig',
  'r',
  'solidity',
  'haskell',
  'hcl',
]);
