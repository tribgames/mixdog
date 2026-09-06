// Aggregate file-anchor resolution for code_graph: which project root a
// `files:` batch selects, when an invalid cwd can be recovered from the
// anchors, how relative anchors are re-rooted, and the federated fan-out
// over registered roots. Extracted from dispatch.mjs.
import { resolve as pathResolve, isAbsolute, relative as pathRelative, dirname as pathDirname } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { _resolveFileProjectRoot, _findDirProjectRoot, _childProjectRoots } from './project-root.mjs';
import { _isFilesystemRootPath, formatFederatedProjectLabel } from './trusted-roots.mjs';

export const _AGGREGATE_FILE_WILDCARD_RE = /[*?[\]{}]/;
export const ROOT_FEDERATED_MODES = new Set([
  'overview', 'symbol', 'find_symbol', 'symbol_search', 'search',
  'references', 'callers', 'callees', 'symbols', 'prewarm',
]);
// Fan-out cap when federation targets are DISCOVERED (immediate child project
// roots of a sentinel-free cwd) rather than registered. Bounds the cost of
// answering a query at a multi-repo parent; registered roots are unaffected.
export const CODE_GRAPH_DISCOVERED_FEDERATION_CAP = (() => {
  const raw = parseInt(process.env.MIXDOG_CODE_GRAPH_FEDERATION_CAP ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
})();

export async function _runCodeGraphFederation(roots, runOne, projectArgs) {
  return Promise.all((roots || []).map(async (root) => {
    let body;
    try { body = await runOne(root, projectArgs); }
    catch (err) { body = `Error: ${err?.message || String(err)}`; }
    return `# project ${formatFederatedProjectLabel(root)}\n${body}`;
  }));
}

// Absorb: file/files arriving as a JSON-stringified array
// (file:"[\"a.mjs\",\"b.mjs\"]") — parse to a real array so the graph lookup
// batches per file instead of treating the JSON text as one (missing) path.
function _parseJsonArrayString(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter(Boolean);
  } catch { /* not JSON — leave untouched */ }
  return null;
}

export function _normalizeGraphFileArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const fileArr = _parseJsonArrayString(args.file);
  const filesArr = _parseJsonArrayString(args.files);
  if (!fileArr && !filesArr) return args;
  const out = { ...args };
  if (fileArr) { out.files = Array.isArray(out.files) ? [...fileArr, ...out.files] : fileArr; delete out.file; }
  if (filesArr) out.files = filesArr;
  // Collapse a lone entry back to the single-file field for the fast path.
  if (Array.isArray(out.files) && out.files.length === 1 && !out.file && !filesArr) {
    out.file = out.files[0];
    delete out.files;
  }
  return out;
}

export function _collectGraphFileList(args) {
  const split = (s) => String(s || '').split(/,+/).map((t) => t.trim()).filter(Boolean);
  return [...new Set([
    ...(Array.isArray(args?.files) ? args.files.map((f) => String(f || '').trim()).filter(Boolean) : []),
    ...(typeof args?.files === 'string' ? split(args.files) : []),
    ...(typeof args?.file === 'string' && args.file.trim() ? [args.file.trim()] : []),
  ])];
}

export function _hasAggregateFileArgs(args) {
  return (Array.isArray(args?.files) && args.files.some((f) => String(f || '').trim()))
    || (typeof args?.files === 'string' && args.files.trim());
}

// Aggregate anchors that ALL resolve to the cwd itself ('.', './', the cwd
// path) add no scope — they mean "search here". Detected so the call can take
// the plain-cwd route, which adopts a sentinel-free single tree (a vendored
// reference checkout) as its own root while still refusing an unbounded or
// multi-project parent. Without this, `files:"."` turned every reference tree
// into a hard "not inside a project" refusal.
export function _aggregateAnchorsAreCwd(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return false;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return false;
  return files.every((file) => {
    const trimmed = String(file || '').trim();
    if (!trimmed || _AGGREGATE_FILE_WILDCARD_RE.test(trimmed)) return false;
    try {
      return pathResolve(isAbsolute(trimmed) ? trimmed : pathResolve(baseCwd, trimmed)) === pathResolve(baseCwd);
    } catch { return false; }
  });
}

// An invalid caller cwd may be recovered for an explicit files aggregate only
// when every supplied anchor points at the same detectable project. Do not use
// the batch cap here: an omitted anchor could belong to another project.
export function _resolveAggregateFileProjectRoot(args, baseCwd, { stopAtUserBoundary = false } = {}) {
  if (!_hasAggregateFileArgs(args)) return null;
  // Comma-delimited strings are parsed for normal batch dispatch, but are not
  // unambiguous enough to select a project root. JSON array strings have
  // already been normalized to an actual array above.
  if (typeof args?.files === 'string' && args.files.includes(',')) return null;
  const files = _collectGraphFileList(args);
  const roots = new Set();
  for (const file of files) {
    // Never infer a root from a glob-shaped anchor, including a literal file
    // whose name contains a glob metacharacter.
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file)) return null;
    const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(baseCwd, file);
    if (!existsSync(abs)) return null;
    let isDirectory = false;
    try { isDirectory = statSync(abs).isDirectory(); } catch { return null; }
    const root = isDirectory
      ? _findDirProjectRoot(abs, { stopAtUserBoundary })
      : _resolveFileProjectRoot(abs, { stopAtUserBoundary });
    if (!root) return null;
    roots.add(pathResolve(root));
  }
  if (roots.size === 0) return null;
  if (roots.size === 1) return [...roots][0];
  // Monorepo anchors legitimately resolve to DIFFERENT sentinels: a workspace
  // package (apps/desktop/package.json) is nearer than the repo root, so one
  // call spanning `apps/desktop/...` and `src/...` yields two roots even though
  // both live in exactly one project. When one candidate contains every other,
  // that outermost root IS the single detectable project — adopt it instead of
  // refusing. Genuinely unrelated trees share no such candidate and still fail.
  return _outermostContainingRoot([...roots]);
}

// An exact absolute FILE is a complete target on its own: the caller named the
// file, so no tree has to be walked to discover it. When that file sits in no
// detectable project — a scratch copy under /tmp, a loose source file outside
// every repo — its own directory is the bounded root to index, the same
// treatment a sentinel-free cwd already gets. A DIRECTORY anchor never
// qualifies: it names a tree to walk rather than a target.
export function _boundedExactFileRoot(absFile) {
  let resolved;
  try {
    resolved = pathResolve(pathDirname(String(absFile || '')));
  } catch {
    return null;
  }
  if (!resolved) return null;
  if (_isFilesystemRootPath(resolved) || resolved === pathResolve(osHomedir())) return null;
  try {
    if (!statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

// Same rule for an aggregate call: every anchor must be an existing FILE and
// they must share exactly one bounded directory, so the adopted root stays as
// narrow as the named targets.
export function _boundedExactFileAggregateRoot(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return null;
  if (typeof args?.files === 'string' && args.files.includes(',')) return null;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return null;
  const roots = new Set();
  for (const file of files) {
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file)) return null;
    const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(baseCwd, file);
    try {
      if (!statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
    const root = _boundedExactFileRoot(abs);
    if (!root) return null;
    roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : null;
}

// A sentinel-free working directory that HOLDS a project (a container's /app
// with one cloned repo under it) answered every anchored call with a refusal:
// the caller wrote the anchor the way the repo's own docs do
// (`tools/compute_image_mean.cpp`), it does not exist under /app, and no root
// could be derived from a path that resolves nowhere. The relative anchor is
// still unambiguous whenever exactly ONE child project holds it — that project
// is the answer, and adopting it is the same recovery read and grep already
// perform for a misplaced path. Ambiguity (several holders, none, an absolute
// anchor, a wildcard) keeps refusing.
export function _relocateAggregateAnchorsUnderChildProject(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return null;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return null;
  for (const file of files) {
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file) || isAbsolute(file)) return null;
    if (existsSync(pathResolve(baseCwd, file))) return null;
  }
  const holders = _childProjectRoots(baseCwd, { cap: 8 })
    .filter((root) => pathResolve(root) !== pathResolve(baseCwd))
    .filter((root) => files.every((file) => {
      try {
        return statSync(pathResolve(root, file)).isFile();
      } catch {
        return false;
      }
    }));
  if (holders.length !== 1) return null;
  const root = pathResolve(holders[0]);
  const remap = (file) => pathResolve(root, String(file || '').trim());
  return {
    root,
    args: {
      ...args,
      file: typeof args?.file === 'string' && args.file.trim() ? remap(args.file) : args?.file,
      files: Array.isArray(args?.files)
        ? args.files.map(remap)
        : (typeof args?.files === 'string' && args.files.trim() ? remap(args.files) : args?.files),
    },
  };
}

export function _resolveBoundedSentinelFreeAggregateRootForTest(args, baseCwd) {
  if (!_hasAggregateFileArgs(args)) return null;
  const base = pathResolve(baseCwd);
  if (_isFilesystemRootPath(base) || base === pathResolve(osHomedir())) return null;
  try {
    if (!statSync(base).isDirectory()) return null;
  } catch {
    return null;
  }
  if (_childProjectRoots(base, { cap: 2 }).length > 0) return null;
  const files = _collectGraphFileList(args);
  if (files.length === 0) return null;
  for (const file of files) {
    if (_AGGREGATE_FILE_WILDCARD_RE.test(file)) return null;
    const abs = isAbsolute(file) ? pathResolve(file) : pathResolve(base, file);
    if (!existsSync(abs)) return null;
    const rel = pathRelative(base, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
  }
  return base;
}

// The candidate that contains (or equals) every other candidate, else null.
// Only an EXISTING candidate can win: a bare common ancestor that has no
// sentinel of its own is never adopted as a project root.
function _outermostContainingRoot(roots) {
  for (const candidate of roots) {
    if (roots.every((root) => _isSameOrInside(root, candidate))) return candidate;
  }
  return null;
}

function _isSameOrInside(child, parent) {
  try {
    const rel = pathRelative(pathResolve(parent), pathResolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

// Aggregate recovery resolves relative anchors against the caller's original
// cwd. Keep those resolved paths when dispatching under the recovered root;
// otherwise codeGraph resolves them a second time below that root.
export function _absolutizeAggregateFileArgs(args, baseCwd) {
  const absolutize = (file) => {
    const trimmed = String(file || '').trim();
    return trimmed && !isAbsolute(trimmed) ? pathResolve(baseCwd, trimmed) : file;
  };
  return {
    ...args,
    file: typeof args?.file === 'string' ? absolutize(args.file) : args?.file,
    files: Array.isArray(args?.files)
      ? args.files.map(absolutize)
      : (typeof args?.files === 'string' ? absolutize(args.files) : args?.files),
  };
}
