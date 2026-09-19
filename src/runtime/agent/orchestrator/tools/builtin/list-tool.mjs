import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hasGlobMagic, normalizeInputPath, normalizeOutputPath, resolveAgainstCwd } from './path-utils.mjs';
import { buildListCacheKey, DEFAULT_IGNORE_GLOBS } from './search-builders.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import { cacheGet, cacheSet, runResultCacheInFlight, lstatPathsForMtime } from './cache-layers.mjs';
import { NOISE_DIR_NAMES, walkDir } from './glob-walk.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';
import { runRgWindowedLines } from './native-search-runner.mjs';
import { tryServeListMetadata } from './native-search-client.mjs';
import { listGuardPath, normalizeListHeadLimit } from './lib/list-helpers.mjs';
import { reportToolProgress } from './lib/tool-progress.mjs';
import {
  recordRuntimeDirectoryReadSuccess,
  reportRuntimeDirectoryReadFailure,
} from '../../../../shared/session-runtime-health.mjs';
import { displayRelPath, statWalkRoot } from './list-tool-shared.mjs';
import { executeFindFilesTool } from './find-files-tool.mjs';

export { executeFindFilesTool, executeFuzzyFindTool } from './find-files-tool.mjs';

const ENTRY_TYPES = new Set(['file', 'dir', 'symlink', 'other']);

function entryTypeOf(item) {
  if (ENTRY_TYPES.has(item.type)) return item.type;
  if (item.stat?.isDirectory?.()) return 'dir';
  if (item.stat?.isFile?.()) return 'file';
  if (item.stat?.isSymbolicLink?.()) return 'symlink';
  return 'other';
}

// Telemetry outcome for a directory walk; `rowCount` is only known when a
// filter ran over the visited entries.
function walkOutcome(walkResult, warningCount, rowCount = null) {
  if (warningCount > 0) return 'partial';
  if (walkResult.entriesVisited === 0) return 'empty';
  if (rowCount === 0) return 'filtered-empty';
  return 'complete';
}

const LIST_WALK_TIMEOUT_MS = 20_000;
const LIST_ABSOLUTE_CAP = 50_000;

function directoryReadFailureLine(failure, warning = false) {
  const code = String(failure?.error?.code || 'UNKNOWN').toUpperCase();
  const path = normalizeOutputPath(failure?.dir || '');
  return `${warning ? '[warning] ' : 'Error: '}readdir failed (${code}): ${path}`;
}

function throwIfDirectoryWalkAborted(signal, walkResult, label) {
  if (!signal?.aborted && !walkResult?.aborted) return;
  if (signal?.reason instanceof Error) throw signal.reason;
  const error = new Error(String(signal?.reason || `${label} aborted`));
  error.name = 'AbortError';
  throw error;
}

function recordDirectoryWalkTelemetry(options, status, walkResult, warningCount = 0) {
  if (!options?.resultTelemetry || typeof options.resultTelemetry !== 'object') return;
  options.resultTelemetry.integrity = {
    kind: 'directory-walk',
    status,
    entriesVisited: Math.max(0, Number(walkResult?.entriesVisited) || 0),
    warnings: Math.max(0, Number(warningCount) || 0),
  };
}

// After a walk: an abort propagates, a root that could not be read is the
// tool's answer (returned as the error line, uncached, and counted against
// the runtime worker's health), and anything else records a healthy read.
function walkRootFailureLine(options, fullPath, walkResult, walkWarnings, label) {
  throwIfDirectoryWalkAborted(options.signal, walkResult, label);
  const rootFailure = walkWarnings.find((warning) => warning.root);
  if (!rootFailure) {
    recordRuntimeDirectoryReadSuccess();
    return null;
  }
  reportRuntimeDirectoryReadFailure(fullPath, rootFailure.error);
  recordDirectoryWalkTelemetry(options, 'failed', walkResult, walkWarnings.length);
  if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  return directoryReadFailureLine(rootFailure);
}

function pageContinuationLine(offset, shown, total) {
  return `... [entries ${offset + 1}-${offset + shown} of ${total}; pass offset:${offset + shown} to continue]`;
}

// A/B override surface for the default result caps (stock: list 100, tree 200,
// fuzzy find 25). Env-gated so bench variants can match competitor-style
// generous caps without changing the shipped defaults.
function _listDefaultHeadLimit(fallback) {
  const parsed = parseInt(process.env.MIXDOG_LIST_DEFAULT_HEAD_LIMIT ?? '', 10);
  return parsed > 0 ? parsed : fallback;
}

// `meta` column renderers: compact `ls -l` equivalents (size bytes,
// second-precision UTC mtime, octal permission bits). Stat-failed entries
// render `?` so a denied/hung lstat is visible instead of masquerading as an
// empty epoch-zero file.
function _metaMtimeIso(mtimeMs) {
  if (!(mtimeMs > 0)) return '?';
  return `${new Date(mtimeMs).toISOString().slice(0, 19)}Z`;
}
function _metaModeOctal(mode) {
  if (!(mode > 0)) return '?';
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

async function listMetadataForPaths(paths, workDir, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const nativeImpl =
    typeof options?.__tryServeListMetadata === 'function' ? options.__tryServeListMetadata : tryServeListMetadata;
  try {
    const entries = await nativeImpl(paths, {
      cwd: workDir,
      signal: options?.signal || options?.abortSignal || null,
      timeout: 5_000,
    });
    if (Array.isArray(entries) && entries.length === paths.length) {
      return entries.map((entry, index) => ({
        fullPath: paths[index],
        type: entry && !entry.error ? String(entry.type || '') : '',
        stat: entry && !entry.error ? { mode: Number(entry.mode) || 0 } : null,
        size: entry && !entry.error ? Math.max(0, Number(entry.size) || 0) : 0,
        mtimeMs: entry && !entry.error ? Math.max(0, Number(entry.mtimeMs) || 0) : 0,
      }));
    }
  } catch {
    // Older/unavailable native helpers preserve the existing JS fallback.
  }
  return lstatPathsForMtime(paths, workDir, 64, { deadlineMs: 5000 });
}

function nativeListRow(path, item) {
  return {
    path,
    type: entryTypeOf(item),
    size: Number(item.size) || 0,
    mtimeMs: Number(item.mtimeMs) || 0,
    // listMetadataForPaths stores permissions at item.stat.mode
    // (both the native and the lstat fallback shape); reading
    // item.mode made every recursive meta:true row print `?`.
    mode: Number(item.stat?.mode ?? item.mode) || 0,
    fullPath: path,
  };
}

async function tryNativeDeepListRows({ fullPath, workDir, depth, hidden, includeNoise, signal, options }) {
  if (depth <= 1 || typeof options?.readdirImpl === 'function') return null;
  const rgArgs = ['--files', '--directories', '--no-ignore', '--no-require-git'];
  if (hidden) rgArgs.push('--hidden');
  rgArgs.push('--max-depth', String(depth));
  if (!includeNoise) {
    for (const glob of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', glob);
  }
  rgArgs.push('--', fullPath);
  try {
    const served = await runRgWindowedLines(
      rgArgs,
      { cwd: workDir, timeout: LIST_WALK_TIMEOUT_MS, signal },
      { offset: 0, limit: LIST_ABSOLUTE_CAP, nativeInventory: true }
    );
    if (served?.complete !== true || served?.partial === true || !Array.isArray(served?.lines)) {
      return null;
    }
    const paths = Array.from(
      new Set(served.lines.map((line) => (isAbsolute(line) ? line : resolveAgainstCwd(line, workDir))))
    ).filter((path) => path !== fullPath);
    const metadata = await listMetadataForPaths(paths, workDir, options);
    if (!Array.isArray(metadata) || metadata.length !== paths.length) return null;
    const rows = paths.map((path, index) => nativeListRow(path, metadata[index] || {}));
    return {
      rows,
      walkResult: {
        entriesVisited: rows.length,
        directoriesVisited: rows.filter((row) => row.type === 'dir').length,
        aborted: false,
        nativeInventory: true,
      },
    };
  } catch {
    return null;
  }
}

function listRequest(args, workDir) {
  const inputPath = args.path || '.';
  const guard = listGuardPath(inputPath);
  if (guard) return { error: guard };
  const fullPath = resolveAgainstCwd(inputPath, workDir);
  const guardFull = listGuardPath(fullPath);
  if (guardFull) return { error: guardFull };
  const sort = ['name', 'mtime', 'size'].includes(args.sort) ? args.sort : 'name';
  const listHeadLimitCap = _listDefaultHeadLimit(100);
  const requestedHeadLimit = normalizeListHeadLimit(args.head_limit, listHeadLimitCap);
  return {
    inputPath,
    fullPath,
    depth: Math.min(Math.max(parseInt(args.depth ?? 1, 10) || 1, 1), 10),
    hidden: Boolean(args.hidden),
    sort,
    typeFilter: ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any',
    headLimit: requestedHeadLimit === 0 ? 0 : Math.min(requestedHeadLimit, listHeadLimitCap),
    offset: typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0,
    needsGlobalStat: sort === 'mtime' || sort === 'size',
    includeNoise: Boolean(args.include_noise),
    meta: Boolean(args.meta),
  };
}

function listCacheKey({ fullPath, depth, hidden, sort, typeFilter, headLimit, offset, includeNoise, meta }) {
  return buildListCacheKey({
    mode: 'list',
    inputPath: normalizeOutputPath(fullPath),
    depth,
    hidden,
    sort,
    typeFilter,
    headLimit,
    offset,
    includeNoise,
    meta,
  });
}

function listRowLine(row, fullPath, meta) {
  const path = displayRelPath(row.path, fullPath);
  if (!meta) return `${path}\t${row.type}`;
  return `${path}\t${row.type}\t${row.size}\t${_metaMtimeIso(row.mtimeMs)}\t${_metaModeOctal(row.mode)}`;
}

function listFileLine(fullPath, st, meta) {
  const path = normalizeOutputPath(fullPath);
  if (!meta) return `${path}\tfile`;
  return `${path}\tfile\t${st.size}\t${_metaMtimeIso(st.mtimeMs)}\t${_metaModeOctal(st.mode)}`;
}

function entryType(ent) {
  if (ent.isDirectory()) return 'dir';
  if (ent.isFile()) return 'file';
  if (ent.isSymbolicLink()) return 'symlink';
  return 'other';
}

// Collects the rows of a listing: the native deep inventory when it can
// serve the request, else a bounded JS walk. Width guard: depth is capped,
// but a single very wide directory tree could push unbounded rows before
// sort/slice runs and exhaust memory. Mirror the find-mode absolute cap +
// walk deadline so the accumulator stops growing once the cap or timeout
// trips. Small dirs never hit either bound, so normal behavior is unchanged.
async function collectListRows(request, workDir, options) {
  const { fullPath, depth, hidden, includeNoise, typeFilter } = request;
  const rows = [];
  const walkWarnings = [];
  const nativeDeep = await tryNativeDeepListRows({
    fullPath,
    workDir,
    depth,
    hidden,
    includeNoise,
    signal: options.signal,
    options,
  });
  if (nativeDeep) {
    for (const row of nativeDeep.rows) {
      if (typeFilter === 'file' && row.type !== 'file') continue;
      if (typeFilter === 'dir' && row.type !== 'dir') continue;
      rows.push(row);
    }
    return { rows, walkResult: nativeDeep.walkResult, walkWarnings, truncatedByCap: false, nativeDeep: true };
  }
  let truncatedByCap = false;
  const walkDeadline = Date.now() + LIST_WALK_TIMEOUT_MS;
  const walkResult = await walkDir(fullPath, {
    hidden,
    maxDepth: depth,
    excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
    signal: options.signal,
    readdirImpl: options.readdirImpl,
    onWarn: (dir, error, context) => walkWarnings.push({ dir, error, root: Boolean(context?.root) }),
    visit: (ent, entPath) => {
      if (Date.now() > walkDeadline) {
        truncatedByCap = true;
        return false;
      }
      const type = entryType(ent);
      if (typeFilter === 'file' && type !== 'file') return;
      if (typeFilter === 'dir' && type !== 'dir') return;
      rows.push({ path: entPath, type, size: 0, mtimeMs: 0, mode: 0, fullPath: entPath });
      // A global name sort needs all candidates collected before slicing,
      // otherwise the visible window depends on traversal order rather than
      // sort order; only the absolute cap stops the walk.
      if (rows.length >= LIST_ABSOLUTE_CAP) {
        truncatedByCap = true;
        return false;
      }
    },
  });
  return { rows, walkResult, walkWarnings, truncatedByCap, nativeDeep: false };
}

// lstat: symlinks should report own metadata, not the target's. The rows
// are updated in place, so a stat over the visible window lands on the
// rendered entries.
async function fillRowMetadata(rows, workDir, options) {
  if (rows.length === 0) return;
  const stats = await listMetadataForPaths(
    rows.map((row) => row.fullPath),
    workDir,
    options
  );
  for (let i = 0; i < rows.length; i++) {
    const item = stats[i];
    if (!item?.stat) continue;
    rows[i].size = item.size;
    rows[i].mtimeMs = item.mtimeMs;
    rows[i].mode = item.stat.mode;
  }
}

function sortListRows(rows, sort) {
  if (sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  else if (sort === 'size') rows.sort((a, b) => b.size - a.size);
  else rows.sort((a, b) => a.path.localeCompare(b.path));
}

// What an empty page means: offset past the end is a windowing condition,
// not a filter one — blaming hidden/type filters there misdirects the next
// call; a filter that hid everything names itself.
async function listEmptyMessage({ inputPath, fullPath, offset, typeFilter, hidden }, rowCount) {
  if (offset > 0 && rowCount > 0) return `(no entries after offset=${offset}; total=${rowCount}) path=${inputPath}`;
  if (typeFilter === 'any' && hidden !== false) return '(empty directory)';
  const filterParts = [];
  if (typeFilter !== 'any') filterParts.push(`type=${typeFilter}`);
  if (hidden === false) {
    let hasHidden = false;
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      hasHidden = entries.some((e) => e.name?.startsWith('.'));
    } catch {}
    filterParts.push(hasHidden ? 'hidden=false (dotfiles present — pass hidden:true to include)' : 'hidden=false');
  }
  return `(no entries match filter) ${filterParts.join(', ')} path=${inputPath}`;
}

export async function executeListTool(args, workDir, options = {}) {
  if (args.mode === 'tree') return executeTreeTool(args, workDir, options);
  if (args.mode === 'find') return executeFindFilesTool(args, workDir, options);
  args.path = normalizeInputPath(args.path);
  if (!args.name && hasGlobMagic(args.path)) {
    return executeFindFilesTool({ ...args, mode: 'find' }, workDir);
  }
  const request = listRequest(args, workDir);
  if (request.error) return request.error;
  const { inputPath, fullPath, sort, headLimit, offset, needsGlobalStat, meta } = request;
  const cacheKey = listCacheKey(request);
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;
  if (options?._listSingleFlightKey !== cacheKey) {
    return await runResultCacheInFlight(
      cacheKey,
      ({ signal }) => executeListTool({ ...args }, workDir, { ...options, signal, _listSingleFlightKey: cacheKey }),
      {
        signal: options?.signal || options?.abortSignal || null,
        scopes: [fullPath],
      }
    );
  }
  const root = await statWalkRoot(fullPath, workDir, inputPath);
  if (root.error) return root.error;
  if (!root.stat.isDirectory()) {
    if (!root.stat.isFile()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
    const out = listFileLine(fullPath, root.stat, meta);
    cacheSet(cacheKey, out, { scopes: [fullPath] });
    return out;
  }
  const { rows, walkResult, walkWarnings, truncatedByCap, nativeDeep } = await collectListRows(
    request,
    workDir,
    options
  );
  const rootFailure = walkRootFailureLine(options, fullPath, walkResult, walkWarnings, 'list walk');
  if (rootFailure) return rootFailure;
  if (!nativeDeep && needsGlobalStat) await fillRowMetadata(rows, workDir, options);
  sortListRows(rows, sort);
  const page = await renderListPage({ request, rows, walkWarnings, truncatedByCap, nativeDeep }, workDir, options);
  recordDirectoryWalkTelemetry(
    options,
    walkOutcome(walkResult, walkWarnings.length, rows.length),
    walkResult,
    walkWarnings.length
  );
  if (options?.scopedCacheOutcome && (truncatedByCap || page.paged || walkWarnings.length > 0)) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  if (walkWarnings.length === 0) cacheSet(cacheKey, page.out, { scopes: [fullPath] });
  reportToolProgress(options, `${page.shown} entries`);
  return page.out;
}

// The visible window of sorted rows plus its paging, truncation and walk
// warning trailers. Paths and entry types are the default list contract;
// size/mtime/mode stat columns are opt-in via `meta` so the `ls -la`
// metadata surface has a first-class home without taxing every listing.
// Meta-only requests stat just the visible window (a global stat already
// ran for mtime/size sorts).
async function renderListPage({ request, rows, walkWarnings, truncatedByCap, nativeDeep }, workDir, options) {
  const { fullPath, headLimit, offset, needsGlobalStat, meta } = request;
  const windowed = offset > 0 ? rows.slice(offset) : rows;
  const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
  if (!nativeDeep && meta && !needsGlobalStat) await fillRowMetadata(sliced, workDir, options);
  const lines = sliced.map((row) => listRowLine(row, fullPath, meta));
  const paged = windowed.length > sliced.length;
  if (paged) lines.push(pageContinuationLine(offset, sliced.length, rows.length));
  if (truncatedByCap) {
    lines.push(
      `... walk truncated at ${LIST_ABSOLUTE_CAP} rows or ${LIST_WALK_TIMEOUT_MS}ms timeout; narrow the path or lower depth for a complete listing`
    );
  }
  for (const warning of walkWarnings) lines.push(directoryReadFailureLine(warning, true));
  const out = lines.length ? lines.join('\n') : await listEmptyMessage(request, rows.length);
  return { out, paged, shown: windowed.length };
}

const TREE_BRANCH_LINE_CAP = 500;

function treeGatherCap(headLimit, offset) {
  return headLimit > 0 ? offset + headLimit + 1 : offset + TREE_BRANCH_LINE_CAP + 1;
}

// Walks the tree into indented branch lines (directories first, then by
// name), stopping once the requested window plus one sentinel row is in.
async function walkTreeLines(fullPath, { depth, hidden, includeNoise, headLimit, offset }, options) {
  const lines = [`${normalizeOutputPath(fullPath)}/`];
  const prefixStack = [''];
  const walkWarnings = [];
  const walkResult = await walkDir(fullPath, {
    hidden,
    maxDepth: depth,
    excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
    signal: options.signal,
    readdirImpl: options.readdirImpl,
    onWarn: (dir, error, context) => walkWarnings.push({ dir, error, root: Boolean(context?.root) }),
    sort: (a, b) => {
      const ad = a.isDirectory();
      const bd = b.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    },
    visit: (ent, _entPath, ctx) => {
      const prefix = prefixStack[ctx.depth - 1] || '';
      const branch = ctx.isLast ? '└── ' : '├── ';
      const display = ent.isDirectory() ? `${ent.name}/` : ent.name;
      lines.push(`${prefix}${branch}${display}`);
      if (ent.isDirectory()) {
        prefixStack[ctx.depth] = prefix + (ctx.isLast ? '    ' : '│   ');
      }
      // Exclude the root line (lines[0]) from the body-row count: the
      // windowed slice operates on lines.slice(1), so gather must measure
      // body rows, not total. Without -1 the sentinel "+N more entries"
      // misfires off-by-one on the boundary.
      if (headLimit !== 0 && lines.length - 1 >= treeGatherCap(headLimit, offset)) return false;
    },
  });
  return { lines, walkResult, walkWarnings };
}

function renderTreeOutput(lines, walkWarnings, { headLimit, offset }) {
  const root = lines[0];
  const body = lines.slice(1);
  const windowed = offset > 0 ? body.slice(offset) : body;
  // head_limit:0 means "no cap" (Infinity); negative/NaN means "use default cap".
  let branchLimit = TREE_BRANCH_LINE_CAP;
  if (headLimit === 0) branchLimit = Infinity;
  else if (headLimit > 0) branchLimit = headLimit;
  const sliced = branchLimit === Infinity ? windowed : windowed.slice(0, branchLimit);
  const outLines = [root, ...sliced];
  const paged = windowed.length > sliced.length;
  if (paged) {
    // The walk stops gathering at the gather cap, so when body filled to the
    // cap the true total is unknown — render `N+` so the caller keeps
    // paging instead of reading the capped count as the real total.
    const totalLabel = body.length >= treeGatherCap(headLimit, offset) ? `${body.length}+` : `${body.length}`;
    outLines.push(pageContinuationLine(offset, sliced.length, totalLabel));
  }
  for (const warning of walkWarnings) outLines.push(directoryReadFailureLine(warning, true));
  let out = outLines.join('\n');
  let outputCharTruncated = false;
  if (out.length > TOOL_OUTPUT_MAX_BYTES) {
    outputCharTruncated = true;
    out =
      out.slice(0, TOOL_OUTPUT_MAX_BYTES) +
      `\n... [output truncated at ${Math.round(TOOL_OUTPUT_MAX_BYTES / 1024)} KB; narrow path or lower depth]`;
  }
  return { out, incomplete: paged || outputCharTruncated };
}

export async function executeTreeTool(args, workDir, options = {}) {
  args.path = normalizeInputPath(args.path);
  const inputPath = args.path || '.';
  const guard = listGuardPath(inputPath);
  if (guard) return guard;
  const fullPath = resolveAgainstCwd(inputPath, workDir);
  const guardFull = listGuardPath(fullPath);
  if (guardFull) return guardFull;
  const request = {
    depth: Math.min(Math.max(parseInt(args.depth ?? 3, 10) || 3, 1), 6),
    hidden: Boolean(args.hidden),
    headLimit: normalizeListHeadLimit(args.head_limit, _listDefaultHeadLimit(200)),
    offset: typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0,
    includeNoise: Boolean(args.include_noise),
  };
  const cacheKey = buildListCacheKey({
    mode: 'tree',
    inputPath: normalizeOutputPath(fullPath),
    depth: request.depth,
    hidden: request.hidden,
    sort: '',
    typeFilter: '',
    headLimit: request.headLimit,
    offset: request.offset,
    includeNoise: request.includeNoise,
  });
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;
  const root = await statWalkRoot(fullPath, workDir, inputPath);
  if (root.error) return root.error;
  if (!root.stat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
  const { lines, walkResult, walkWarnings } = await walkTreeLines(fullPath, request, options);
  const rootFailure = walkRootFailureLine(options, fullPath, walkResult, walkWarnings, 'tree walk');
  if (rootFailure) return rootFailure;
  const { out, incomplete } = renderTreeOutput(lines, walkWarnings, request);
  recordDirectoryWalkTelemetry(options, walkOutcome(walkResult, walkWarnings.length), walkResult, walkWarnings.length);
  if (options?.scopedCacheOutcome && (incomplete || walkWarnings.length > 0)) {
    markScopedCacheIncomplete(options.scopedCacheOutcome);
  }
  if (walkWarnings.length === 0) cacheSet(cacheKey, out, { scopes: [fullPath] });
  return out;
}
