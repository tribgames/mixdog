import { markScopedCacheIncomplete } from '../../../session/cache/scoped-cache-outcome.mjs';
import { canonicalizeGlobSlashes } from '../path-utils.mjs';
import { relativePathPrefix } from '../search-path-diagnostics.mjs';
import { normalizeGrepLine, splitGrepCountPrefix, splitGrepLinePrefix } from '../grep-formatting.mjs';

export function relativeGrepLine(
  line,
  workDir,
  pathOnly = false,
  outputMode = 'content',
  filenameOmitted = false,
  matchOnly = false
) {
  const normalized = normalizeGrepLine(line, pathOnly, outputMode, filenameOmitted, matchOnly);
  if (!workDir) return normalized;
  if (pathOnly) return relativePathPrefix(normalized, workDir);
  if (filenameOmitted) return normalized;
  const split = splitGrepLinePrefix(normalized, matchOnly);
  if (split) {
    return relativePathPrefix(normalized.slice(0, split.pathEnd), workDir) + normalized.slice(split.pathEnd);
  }
  if (outputMode === 'count') {
    const countSplit = splitGrepCountPrefix(normalized);
    if (countSplit) {
      return (
        relativePathPrefix(normalized.slice(0, countSplit.pathEnd), workDir) + normalized.slice(countSplit.pathEnd)
      );
    }
  }
  return normalized;
}

export function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value)));
}

export function coerceNonNegInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.floor(n);
}

// String or string[] argument → its non-empty string entries.
export function stringList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry);
  return value ? [String(value)] : [];
}

// head_limit shared by the single-path flow and the path[] fan-out:
// absent → the default cap, 0 → unlimited, otherwise the coerced integer.
export function resolveHeadLimit(coerced, defaultLimit) {
  if (coerced === null) return defaultLimit;
  return coerced === 0 ? Infinity : coerced;
}

// Validates the shared head_limit/offset window arguments. `error` is the
// tool-error text; otherwise the resolved limit (Infinity = unlimited), the
// coerced limit as given (null when absent, 0 when explicitly unlimited) and
// the offset.
export function resolveSearchWindow(args, defaultHeadLimit) {
  const headLimitCoerced = coerceNonNegInt(args.head_limit);
  if (Number.isNaN(headLimitCoerced)) {
    return {
      error: `Error: invalid limit ${JSON.stringify(args.head_limit)}; expected a non-negative integer (0 = unlimited)`,
    };
  }
  const offsetCoerced = coerceNonNegInt(args.offset);
  if (Number.isNaN(offsetCoerced)) {
    return { error: `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer` };
  }
  return {
    headLimit: resolveHeadLimit(headLimitCoerced, defaultHeadLimit),
    headLimitCoerced,
    offset: offsetCoerced || 0,
  };
}

// A pattern list capped at `cap`. Dropping input patterns means the result
// cannot cover the requested set — never cache it as complete, and key the
// cache on the original count (`total`) so a capped request never collides
// with an exact N-pattern one.
export function capPatternList(requested, cap, options) {
  if (requested.length <= cap) return { patterns: requested, note: '', total: 0 };
  if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
  return {
    patterns: requested.slice(0, cap),
    note: `[capped at ${cap} of ${requested.length} patterns]\n`,
    total: requested.length,
  };
}

export function globMtimeTiePath(entry) {
  const p = String(entry?.path ?? entry?.full ?? '');
  return process.platform === 'win32' ? p.toLocaleLowerCase() : p;
}

export function isRedundantAllFilesGlob(value) {
  const g = canonicalizeGlobSlashes(String(value || '').trim())
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return g === '**/*' || g === '**';
}

export function parseGrepCountLine(line) {
  const text = String(line || '');
  const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
  const idx = text.lastIndexOf(':');
  if (idx <= searchFrom) return null;
  const count = Number(text.slice(idx + 1));
  if (!Number.isFinite(count) || count <= 0) return null;
  const path = text.slice(0, idx);
  if (!path) return null;
  return { path, count };
}
