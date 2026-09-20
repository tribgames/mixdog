/**
 * read-tool/batch-snapshot.mjs — the reads[] coalesce path's return trip:
 * slice every caller slot back out of the union window it was served from,
 * then record the exact delivered ranges (with hashes) as the read snapshot
 * the edit tools verify against.
 */
import { readFile } from 'node:fs/promises';

// Coalesced batch reads fetch the union window from disk; every caller slot
// must be sliced back to its original request window (_orig*), not the
// coalesced union offset/limit fields.
export function restoreCallerSlots(results, origEntries, entryMap, options, { sliceReadBodyByLines }) {
  return origEntries.map((orig, i) => {
    const r = results[entryMap ? entryMap[i] : i] || {
      path: orig.path,
      mode: orig.mode || 'full',
      body: 'Error: dedup mapping failed',
    };
    const isFullMode = !orig.mode || orig.mode === 'full';
    const needsSlice = isFullMode && orig._needsPerEntrySlice === true;
    const origOffset = typeof orig._origOffset === 'number' ? orig._origOffset : 0;
    const origLimit = typeof orig._origLimit === 'number' ? orig._origLimit : 2000;
    const body =
      needsSlice && typeof r.body === 'string'
        ? sliceReadBodyByLines(r.body, origOffset, origLimit, options.readOffsetBase ?? 0)
        : r.body;
    return { ...r, mode: orig.mode || 'full', n: orig.n, body };
  });
}

function deliveredRangesByPath(
  orderedResults,
  workDir,
  { classifyResultKind, resolveAgainstCwd, _rangeHashesFromRenderedReadText }
) {
  const exactRangesByPath = new Map();
  const rangeHashesByPath = new Map();
  for (const r of orderedResults) {
    if (r?.mode !== 'full' || classifyResultKind(String(r.body || '')) === 'error') continue;
    const m = String(r.body || '').match(/\[lines\s+(\d+)-(\d+)\s+of\s+(\d+)/);
    if (!m) continue;
    const startLine = Number(m[1]);
    const endLine = Number(m[2]);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    const fullPath = resolveAgainstCwd(r.path, workDir);
    if (!exactRangesByPath.has(fullPath)) exactRangesByPath.set(fullPath, []);
    const range = { startLine, endLine };
    exactRangesByPath.get(fullPath).push(range);
    const renderedHashes = _rangeHashesFromRenderedReadText(r.body, [range]);
    if (renderedHashes.length > 0) {
      if (!rangeHashesByPath.has(fullPath)) rangeHashesByPath.set(fullPath, []);
      rangeHashesByPath.get(fullPath).push(...renderedHashes);
    }
  }
  return { exactRangesByPath, rangeHashesByPath };
}

async function rawRangeHashes(fullPath, mergedRanges, { _hashText }) {
  try {
    const rawLines = (await readFile(fullPath, 'utf-8')).split('\n');
    return mergedRanges.map((range) => {
      const startIdx = Math.max(0, range.startLine - 1);
      const endIdx = Math.min(rawLines.length, range.endLine);
      return { ...range, hash: _hashText(rawLines.slice(startIdx, endIdx).join('\n')) };
    });
  } catch {
    /* best-effort range hashes */
    return [];
  }
}

export async function recordSlicedBatchSnapshots(orderedResults, workDir, readStateScope, helpers) {
  const { _mergeReadRanges, _recordReadSnapshot } = helpers;
  const { exactRangesByPath, rangeHashesByPath } = deliveredRangesByPath(orderedResults, workDir, helpers);
  for (const [fullPath, ranges] of exactRangesByPath) {
    const mergedRanges = _mergeReadRanges(ranges);
    let rangeHashes = rangeHashesByPath.get(fullPath) || [];
    if (rangeHashes.length === 0 && mergedRanges.length > 0) {
      rangeHashes = await rawRangeHashes(fullPath, mergedRanges, helpers);
    }
    _recordReadSnapshot(fullPath, undefined, readStateScope, {
      source: 'read_batch_sliced',
      ranges: mergedRanges,
      rangeHashes,
      replaceExisting: true,
    });
  }
}
