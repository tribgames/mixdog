/**
 * read-tool/batch-entries.mjs — how a batch read's entries are shaped before
 * dispatch: the reads[] object form (per-entry options, same-file coalescing,
 * union-window dedup), the uniform string/array form, and the primary-index
 * map that lets a repeated path/window be read once.
 */
import { mergeOverlappingReadEntries, readEntryCoalescedDiskWindow } from '../read-batch.mjs';

// `file_path` alias on a per-entry batch: file_path is 1-based (SDK schema),
// so decrement a positive offset to match the 0-based `path` form. Mirrors
// the scalar alias adjustment in read-tool.mjs.
function objectBatchEntry(r, workDir, { normalizeInputPath, normaliseReadLineWindowArgs }) {
  const entryUsesFilePathAlias = typeof r?.file_path === 'string' && !r?.path;
  const entry = { path: normalizeInputPath(r?.path ?? r?.file_path ?? '') };
  if (r?.mode !== undefined) entry.mode = r.mode;
  if (r?.n !== undefined) entry.n = r.n;
  if (r?.offset !== undefined) {
    if (entryUsesFilePathAlias) {
      const ccOff = Number(r.offset);
      entry.offset = Number.isFinite(ccOff) && ccOff > 0 ? Math.trunc(ccOff) - 1 : r.offset;
    } else {
      entry.offset = r.offset;
    }
  }
  if (r?.limit !== undefined) entry.limit = r.limit;
  if (r?.full !== undefined) entry.full = r.full;
  return normaliseReadLineWindowArgs(entry, workDir);
}

// Deduplicate so the same union-range is read only once per path.
function dedupeUnionWindows(entries) {
  const seen = new Map(); // cacheKey → dedupedEntries index
  const dedupedEntries = [];
  const entryToDeduped = []; // entries[i] → dedupedEntries index
  for (const e of entries) {
    const diskWin = readEntryCoalescedDiskWindow(e);
    const key = `${e.path}|${diskWin?.offset ?? e.offset ?? ''}|${diskWin?.limit ?? e.limit ?? ''}|${e.mode ?? ''}|${e.n ?? ''}|${e.full ?? ''}`;
    if (seen.has(key)) {
      entryToDeduped.push(seen.get(key));
    } else {
      seen.set(key, dedupedEntries.length);
      entryToDeduped.push(dedupedEntries.length);
      dedupedEntries.push(e);
    }
  }
  return { dedupedEntries, entryToDeduped };
}

// reads[] / path: object[] — each entry carries its own options. Same-path
// entries are coalesced so the file is opened once; nearby ranges cluster
// instead of merging into one huge window, and overlapping windows of one
// file render as a single block so no requested line is delivered twice.
// The merged result is sliced back into the original per-entry windows at
// response assembly. Returns `{ error }` or `{ args }` (untouched when the
// path is not an object batch).
export function normalizeObjectBatchArgs(args, workDir, helpers) {
  if (!(Array.isArray(args.path) && args.path.length > 0 && args.path[0] && typeof args.path[0] === 'object')) {
    return { args };
  }
  const { coalesceObjectReadEntries, resolveAgainstCwd } = helpers;
  const rawEntries = args.path.map((r) => objectBatchEntry(r, workDir, helpers));
  const inverted = rawEntries.find((e) => e?._invertedRangeError);
  if (inverted) return { error: inverted._invertedRangeError };
  const resolve = (p) => resolveAgainstCwd(p, workDir);
  const entries = coalesceObjectReadEntries(mergeOverlappingReadEntries(rawEntries, resolve), resolve);
  const { dedupedEntries, entryToDeduped } = dedupeUnionWindows(entries);
  if (entries.length === 0) return { error: 'Error: reads array must not be empty' };
  // Dispatch deduplicated reads in parallel; re-assemble in original order.
  return {
    args: {
      ...args,
      path: dedupedEntries.map((e) => e.path),
      _readsEntries: dedupedEntries,
      _readsOrigEntries: entries,
      _readsEntryToDeduped: entryToDeduped,
      mode: undefined,
      n: undefined,
      offset: undefined,
      limit: undefined,
      full: undefined,
    },
  };
}

// Public file_path batches arrive as normalized zero-based regions. Legacy
// string batches use uniform top-level windows. When _readsEntries is set,
// per-entry options override the uniform set.
export function batchEntriesFromArgs(args, workDir, { normalizeInputPath, normaliseReadLineWindowArgs }) {
  const overrides = Array.isArray(args._readsEntries) ? args._readsEntries : null;
  const entries = args.path.map((p, i) => {
    if (overrides?.[i]) return overrides[i];
    const entry =
      p && typeof p === 'object'
        ? { path: normalizeInputPath(p.path ?? p.file_path ?? '') }
        : { path: normalizeInputPath(p) };
    if (args.mode !== undefined) entry.mode = args.mode;
    if (args.n !== undefined) entry.n = args.n;
    if (args.offset !== undefined) entry.offset = args.offset;
    if (args.limit !== undefined) entry.limit = args.limit;
    if (args.full !== undefined) entry.full = args.full;
    return normaliseReadLineWindowArgs(entry, workDir);
  });
  const inverted = entries.find((e) => e?._invertedRangeError);
  if (inverted) return { error: inverted._invertedRangeError };
  if (entries.length === 0) return { error: 'Error: path array must not be empty' };
  return { entries, overrides };
}

// Dedup string-batch entries by RESOLVED path + window so a file that appears
// twice (incl. two path strings that resolve to the same file) is
// stat/opened/read ONCE, not per duplicate. Duplicates copy the primary's
// body, keeping the per-index render byte-identical. Skipped when
// `overrides` (reads[] coalesce path) is set — those entries were already
// deduped upstream and carry the union-slice bookkeeping.
export function primaryReadIndexes(entries, overrides, resolve) {
  const readIndexFor = new Array(entries.length);
  if (overrides) {
    for (let i = 0; i < entries.length; i++) readIndexFor[i] = i;
    return readIndexFor;
  }
  const dedup = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e?.path) {
      readIndexFor[i] = i;
      continue;
    }
    const k = `${resolve(e.path)}|${e.mode ?? ''}|${e.offset ?? ''}|${e.limit ?? ''}|${e.n ?? ''}|${e.full ?? ''}`;
    if (dedup.has(k)) {
      readIndexFor[i] = dedup.get(k);
    } else {
      dedup.set(k, i);
      readIndexFor[i] = i;
    }
  }
  return readIndexFor;
}
