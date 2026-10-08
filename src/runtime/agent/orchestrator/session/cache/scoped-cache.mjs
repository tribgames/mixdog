// Scoped tool cache for deterministic multi-file-scope tools (grep/glob/list
// and code-graph lookups).
// Write-class tools invalidate only entries whose registered root contains the
// touched path; unknown paths still fall back to a full session clear.
import { join, resolve as _pathResolve, isAbsolute as _pathIsAbs, normalize as _pathNorm } from 'node:path';
import { _normalizeCacheKey } from './util.mjs';
import {
  GREP_AUTO_CONTEXT_AFTER,
  GREP_AUTO_CONTEXT_BEFORE,
  hasGlobMagic,
  normalizeGrepArgs,
} from '../../tools/builtin/path-utils.mjs';
import { validateBuiltinArgs } from '../../tools/builtin/arg-guard.mjs';
import { registerCacheInvalidationListener } from '../../tools/builtin/cache-layers.mjs';
import { setBoundedTextCacheEntry } from './text-cache-budget.mjs';

const MAX_PER_SESSION = 100;
export const SCOPED_CACHE_TTL_MS = 30_000;
let mutationGeneration = 0;

// A result started before invalidation must not repopulate the session cache.
export function scopedCacheGeneration() {
  return mutationGeneration;
}

// sessionId -> Map<key, { content, ts, firstToolUseId, depRoots }>
const _scopedBySession = new Map();

function _canonicalArgs(args) {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return String(args);
  try {
    const keys = Object.keys(args).sort();
    const sorted = {};
    for (const k of keys) {
      const v = args[k];
      if (v === undefined || v === null || v === '') continue;
      sorted[k] = v;
    }
    return JSON.stringify(sorted);
  } catch {
    return String(args);
  }
}

function _firstArg(args, names) {
  for (const name of names) {
    if (args?.[name] === undefined || args?.[name] === null || args?.[name] === '') continue;
    return args[name];
  }
  return undefined;
}

const GREP_ARG_ALIASES = {
  pattern: ['query', 'regex', 'regexp', 'needle', 'search', 'literal'],
  glob: ['file_pattern', 'filePattern', 'include', 'includes', 'files'],
  path: ['root', 'directory', 'dir'],
};
const GLOB_ARG_ALIASES = {
  pattern: ['glob', 'file_pattern', 'filePattern', 'name', 'include', 'includes', 'files'],
  path: ['root', 'directory', 'dir'],
};

// An empty canonical field takes the first alias spelling present; every
// alias is then dropped so spellings never split the cache key.
function _adoptAliases(next, aliasesByKey) {
  for (const [key, aliases] of Object.entries(aliasesByKey)) {
    if (next[key] === undefined || next[key] === null || next[key] === '') {
      const alias = _firstArg(next, aliases);
      if (alias !== undefined) next[key] = alias;
    }
  }
  for (const aliases of Object.values(aliasesByKey)) for (const k of aliases) delete next[k];
}

function _canonicalGrepArgs(next) {
  // Follow the builtin execution order on a private copy. In particular,
  // public mode:"content" requests automatic context; legacy
  // output_mode:"content" is bare. The guard also owns context aliases,
  // numeric coercion and clamp notices. Invalid requests cannot hit a
  // successful cache entry and must reach the executor's error path.
  const adopted = structuredClone(next);
  if (adopted && typeof adopted === 'object') delete adopted._clampNotices;
  if (validateBuiltinArgs('grep', adopted) !== null) return null;
  normalizeGrepArgs(adopted);
  _adoptAliases(adopted, GREP_ARG_ALIASES);
  delete adopted.mode;

  // Canonicalize by execution semantics, not caller spelling:
  // omitted/content_with_context => content + the automatic asymmetric
  // window, spelled as the -B/-A pair it actually runs as;
  // context:0 => bare content; context flags are ignored in count/files.
  const requestedMode = typeof adopted.output_mode === 'string' ? adopted.output_mode.trim() : '';
  if (requestedMode === 'files_with_matches' || requestedMode === 'count') {
    adopted.output_mode = requestedMode;
    delete adopted['-A'];
    delete adopted['-B'];
    delete adopted.context;
    return adopted;
  }
  const hasExplicitContext = ['-A', '-B', 'context'].some((key) => Object.hasOwn(adopted, key));
  adopted.output_mode = 'content';
  if ((requestedMode === '' || requestedMode === 'content_with_context') && !hasExplicitContext) {
    adopted['-B'] = GREP_AUTO_CONTEXT_BEFORE;
    adopted['-A'] = GREP_AUTO_CONTEXT_AFTER;
  }
  if (adopted.context === 0 && !Object.hasOwn(adopted, '-A') && !Object.hasOwn(adopted, '-B')) {
    delete adopted.context;
  }
  return adopted;
}

function _canonicalToolArgs(toolName, args) {
  if (toolName === 'grep') return _canonicalGrepArgs(args);
  if (!args || typeof args !== 'object') return args;
  const next = { ...args };
  if (toolName === 'glob') _adoptAliases(next, GLOB_ARG_ALIASES);
  return next;
}

function _scopedKey(toolName, args, cwd) {
  // Include resolved cwd in the key so identical (toolName, args) pairs from
  // different working directories do not collide.
  const canonicalArgs = _canonicalToolArgs(toolName, args);
  if (toolName === 'grep' && canonicalArgs === null) return null;
  const cwdPart = typeof cwd === 'string' && cwd.length > 0 ? _normalizeCacheKey(cwd) : '';
  return `${toolName}|cwd=${cwdPart}|${_canonicalArgs(canonicalArgs)}`;
}

function _extractGlobRoot(value) {
  if (!hasGlobMagic(value)) return value;
  const text = String(value);
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash <= 0) return '.';
  return text.slice(0, slash);
}

function _normalizeScopedAbs(value, cwd) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const base = cwd && typeof cwd === 'string' ? cwd : process.cwd();
  try {
    const root = _extractGlobRoot(value);
    return _normalizeCacheKey(_pathNorm(_pathIsAbs(root) ? root : _pathResolve(base, root)));
  } catch {
    return null;
  }
}

function _collectPathValues(value, out) {
  if (typeof value === 'string' && value.length > 0) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) _collectPathValues(item, out);
  }
}

function _scopedDependencyRoots(toolName, args, cwd, dependencyRoots) {
  const roots = new Set();
  const add = (value) => {
    const abs = _normalizeScopedAbs(value, cwd);
    if (abs) roots.add(abs);
  };
  if (dependencyRoots) {
    // Roots recorded by the tool as it executed; path args are not re-guessed.
    for (const root of dependencyRoots) add(root);
    return [...roots];
  }
  const canonicalArgs = _canonicalToolArgs(toolName, args);
  const rawPaths = [];
  if (canonicalArgs && typeof canonicalArgs === 'object') {
    _collectPathValues(canonicalArgs.file, rawPaths);
    _collectPathValues(canonicalArgs.path, rawPaths);
    _collectPathValues(canonicalArgs.root, rawPaths);
  }
  if (rawPaths.length > 0) {
    for (const p of rawPaths) add(p);
    // `glob` results are gated on the pattern's static (non-magic) prefix,
    // not just cwd/path root — a pattern like "src/**/*.mjs" must register
    // "src", not just cwd, or edits under src/ that are not directly under
    // the given path root will not invalidate the cached glob result.
    if (toolName === 'glob' && canonicalArgs && typeof canonicalArgs.pattern !== 'undefined') {
      const patterns = [];
      _collectPathValues(canonicalArgs.pattern, patterns);
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || !hasGlobMagic(pattern)) continue;
        const patternRoot = _extractGlobRoot(pattern);
        if (_pathIsAbs(patternRoot)) {
          add(patternRoot);
        } else if (rawPaths.length > 0) {
          for (const p of rawPaths) add(join(p, patternRoot));
        } else {
          add(patternRoot);
        }
      }
    }
  } else if (cwd && typeof cwd === 'string') {
    add(cwd);
  }
  return [...roots];
}

function _pathTouchesRoot(absPath, root) {
  if (!absPath || !root) return false;
  return (
    absPath === root ||
    absPath.startsWith(root.endsWith('/') ? root : `${root}/`) ||
    root.startsWith(absPath.endsWith('/') ? absPath : `${absPath}/`)
  );
}

/**
 * Look up a cached result for a deterministic multi-file-scope tool. Returns
 * null on miss. On hit returns the full entry
 * { content, firstToolUseId, ts }.
 */
export function tryScopedToolCached({ sessionId, toolName, args, cwd, touch = true } = {}) {
  if (!sessionId || !toolName) return null;
  const map = _scopedBySession.get(sessionId);
  if (!map) return null;
  const key = _scopedKey(toolName, args, cwd);
  if (key === null) return null;
  const entry = map.get(key);
  if (!entry || Date.now() - entry.ts >= SCOPED_CACHE_TTL_MS) {
    if (entry) map.delete(key);
    return null;
  }
  if (touch) {
    map.delete(key);
    map.set(key, entry);
  }
  return { content: entry.content, firstToolUseId: entry.firstToolUseId || null, ts: entry.ts };
}

/**
 * Cache a successful tool result. Skip caching empty content (sanity guard).
 * `toolUseId` lets cache hits reference back to the first call that
 * populated the entry so the body need not be re-delivered.
 */
export function setScopedToolCached({
  sessionId,
  toolName,
  args,
  cwd,
  content,
  toolUseId,
  complete = true,
  cacheSafe = true,
  generation = mutationGeneration,
  dependencyRoots,
}) {
  if (!sessionId || !toolName) return;
  if (generation !== mutationGeneration) return;
  if (complete === false || cacheSafe === false) return;
  if (typeof content !== 'string' || content.length === 0) return;
  // code_graph resolves its own roots; without recorded evidence the entry
  // could not be invalidated precisely, so it is not cached.
  const recorded = dependencyRoots ? [...dependencyRoots] : null;
  if (toolName === 'code_graph' && !recorded?.length) return;
  const key = _scopedKey(toolName, args, cwd);
  if (key === null) return;
  let map = _scopedBySession.get(sessionId);
  if (!map) {
    map = new Map();
    _scopedBySession.set(sessionId, map);
  }
  const depRoots = _scopedDependencyRoots(toolName, args, cwd, recorded?.length ? recorded : null);
  setBoundedTextCacheEntry(
    map,
    key,
    { content, ts: Date.now(), firstToolUseId: toolUseId || null, depRoots },
    { maxEntries: MAX_PER_SESSION }
  );
}

/**
 * Full clear of the scoped tool cache for one session. Used when touched
 * paths are unknown or a broad mutation may have changed many files.
 */
export function clearScopedToolsForSession(sessionId) {
  if (!sessionId) return;
  mutationGeneration += 1;
  _scopedBySession.delete(sessionId);
}

/**
 * Targeted scoped-cache invalidation: evict only entries whose registered
 * dependency roots contain, or are contained by, at least one of the given
 * touched paths (single bounded pass; MAX_PER_SESSION entries). Full wipe
 * when paths cannot be resolved.
 */
export function clearScopedToolsForSessionPaths(sessionId, touchedPaths, cwd) {
  if (!sessionId || !Array.isArray(touchedPaths) || touchedPaths.length === 0) return;
  mutationGeneration += 1;
  if (!_scopedBySession.has(sessionId)) return;
  clearSessionForAbsPaths(sessionId, touchedCacheKeys(touchedPaths, cwd));
}

// Normalized, deduplicated absolute cache keys of the touched paths;
// unresolvable entries are dropped.
function touchedCacheKeys(touchedPaths, cwd) {
  const base = cwd && typeof cwd === 'string' ? cwd : process.cwd();
  const out = new Set();
  for (const p of touchedPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    try {
      out.add(_normalizeCacheKey(_pathNorm(_pathIsAbs(p) ? p : _pathResolve(base, p))));
    } catch {
      /* unresolvable: dropped */
    }
  }
  out.delete('');
  return [...out];
}

// Evicts the session's entries whose dependency roots touch any of the
// already-normalized `absPaths` in a single pass. Empty `absPaths` means the
// paths were unresolvable: full wipe.
function clearSessionForAbsPaths(sessionId, absPaths) {
  if (absPaths.length === 0) {
    _scopedBySession.delete(sessionId);
    return;
  }
  const map = _scopedBySession.get(sessionId);
  if (!map) return;
  for (const [key, entry] of map) {
    const roots = Array.isArray(entry?.depRoots) ? entry.depRoots : [];
    if (roots.some((root) => absPaths.some((abs) => _pathTouchesRoot(abs, root)))) map.delete(key);
  }
}

// Builtin writes and watcher invalidations must reach every session, not only
// the one that happened to execute the mutation. TTL covers external changes
// that no watcher reports.
registerCacheInvalidationListener((paths) => {
  mutationGeneration += 1;
  if (paths?.length) {
    const absPaths = touchedCacheKeys(paths);
    for (const sessionId of [..._scopedBySession.keys()]) clearSessionForAbsPaths(sessionId, absPaths);
  } else {
    for (const sessionId of [..._scopedBySession.keys()]) clearScopedToolsForSession(sessionId);
  }
});
