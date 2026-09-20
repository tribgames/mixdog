/**
 * read-single-stream.mjs — the Read answers that never hold the whole body
 * in memory: the binary preview, the streamed line window and the streamed
 * smart summary. Each records the same cache entry + read snapshot the
 * buffered path does, under the caller's cacheKey.
 */
import { formatBinaryReadPreviewFromBuffer } from './binary-file.mjs';
import { readPrefixHash } from './read-single-fast-paths.mjs';

export function binaryPreviewResult(ctx, preview, helpers) {
  const { fullPath, filePath, st, cacheKey, readStateScope } = ctx;
  const { normalizeOutputPath, _recordReadSnapshot, _cacheSet } = helpers;
  const { text, snapshotMeta } = formatBinaryReadPreviewFromBuffer(preview, normalizeOutputPath(filePath), st.size);
  _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
  _cacheSet(cacheKey, text, { paths: [fullPath], readSnapshotMeta: snapshotMeta });
  return text;
}

async function commitStreamResult(ctx, out, snapshotMeta, prefixHash, helpers) {
  const { fullPath, st, cacheKey, readStateScope } = ctx;
  const { _cacheSet, _recordReadSnapshot, _hashText } = helpers;
  // Prefix hash for the race guard on the next cache hit; async so a 64KB
  // read never blocks the event loop on the large-file streaming path.
  const contentPrefixHash = prefixHash || (await readPrefixHash(fullPath, st, _hashText));
  _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash });
  _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
  return out;
}

/**
 * Streamed line window. `source` is 'read' on the >READ_MAX_SIZE_BYTES path
 * and 'read_stream_range' on the ordinary large-range path.
 * W1 H: the snapshot covers only the emitted line bounds, not the requested
 * window — byte-cap truncation can stop short. rangeHashes cover the exact
 * text returned so _isSnapshotStale can detect same-mtime+same-size rewrites
 * within the window at edit time; they hash raw line text (the rendered
 * "N\ttext" prefix stripped) to match what _isSnapshotStale hashes.
 */
export async function streamRangeResult(ctx, { source, fileHandle, prefixBuffer }, helpers) {
  const { fullPath, filePath, st, offset, limit, readMaxOutputBytes, readOffsetBase } = ctx;
  const { streamReadRange, normalizeErrorMessage, _rangeHashesFromRenderedReadText } = helpers;
  try {
    const res = await streamReadRange(fullPath, offset, limit, st, {
      displayPath: filePath,
      maxOutputBytes: readMaxOutputBytes,
      readOffsetBase,
      fileHandle,
      prefixBuffer,
    });
    const ranges =
      res.firstEmitted && res.lastEmitted ? [{ startLine: res.firstEmitted, endLine: res.lastEmitted }] : [];
    const snapshotMeta = { source, ranges, rangeHashes: _rangeHashesFromRenderedReadText(res.text, ranges) };
    return await commitStreamResult(ctx, res.text, snapshotMeta, res.prefixHash, helpers);
  } catch (err) {
    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
  }
}

/**
 * Whole-file reads above the smart-stream threshold use stream smart-elide
 * (then READ_MAX_OUTPUT_BYTES truncation) instead of refusing. Returns null
 * when no summary was produced so the caller falls through to the regular
 * read path, which still enforces the output caps.
 */
export async function smartStreamResult(ctx, helpers) {
  const { fullPath, st } = ctx;
  const { streamSmartReadSummary } = helpers;
  try {
    const res =
      typeof streamSmartReadSummary === 'function'
        ? await streamSmartReadSummary(fullPath, st, 'read_smart_stream')
        : null;
    if (!res?.text) return null;
    const snapshotMeta = res.snapshotMeta || { source: 'read_smart_stream', ranges: [] };
    return await commitStreamResult(ctx, res.text, snapshotMeta, res.prefixHash, helpers);
  } catch {
    return null;
  }
}
