import { open, stat } from 'node:fs/promises';
import { hashText } from './hash-utils.mjs';
import { runResultCacheInFlight } from './cache-layers.mjs';
import {
  canonicalCachePath,
  getReadRangeIndex,
  nearestReadRangeAnchor,
  maybeRecordReadRangeAnchor,
  publishReadRangeIndex,
} from './read-range-index.mjs';
import { READ_MAX_SCAN_BYTES, READ_STREAM_TIMEOUT_MS } from './read-constants.mjs';
import { canCacheReadFile } from './read-cache-policy.mjs';

// Raw, one-based inclusive source windows. Callers merge/sort intervals first.
// Unlike the display reader, this never truncates a line into usable patch text.
export async function readSourceWindows(path, intervals, { signal } = {}) {
  signal?.throwIfAborted();
  if (!intervals.length) return new Map();
  const snapshot = intervals.map(({ start, end }) => ({ start, end }));
  // A later caller must not join a scan that already observed old deep bytes.
  // Preserve small-file fan-out and its per-subscriber cancellation contract.
  if (!canCacheReadFile(await stat(path))) return scanSourceWindows(path, snapshot, signal);
  const key = `source-windows:${canonicalCachePath(path)}:${JSON.stringify(snapshot.map((w) => [w.start, w.end]))}`;
  const shared = await runResultCacheInFlight(
    key,
    ({ signal: sharedSignal }) => scanSourceWindows(path, snapshot, sharedSignal),
    { signal, scopes: [path] }
  );
  return new Map(shared);
}

async function scanSourceWindows(path, intervals, signal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('source context requires a regular file');
    const index = await getReadRangeIndex(path, st, handle);
    const anchor = nearestReadRangeAnchor(index, intervals[0].start - 1);
    let position = anchor.byteOffset;
    let line = anchor.line + 1;
    let interval = 0;
    let scanned = 0;
    let retained = 0;
    let parts = [];
    let partBytes = 0;
    const lines = new Map();
    const minChunkBytes = 64 * 1024;
    const maxChunkBytes = 1024 * 1024;
    let chunkBytes = minChunkBytes;
    let buffer = Buffer.allocUnsafe(chunkBytes);
    const deadline = Date.now() + READ_STREAM_TIMEOUT_MS;
    const check = () => {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('source context read timed out');
    };
    const save = (segment, complete) => {
      if (line < intervals[interval].start) return;
      retained += segment.length;
      partBytes += segment.length;
      if (retained > 8 * 1024 * 1024 || partBytes > 1024 * 1024) {
        throw new Error('source context exceeds the bounded raw-text budget');
      }
      if (!complete) {
        parts.push(Buffer.from(segment));
        return;
      }
      let bytes = parts.length ? Buffer.concat([...parts, segment], partBytes) : segment;
      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1);
      lines.set(line, bytes.toString('utf8'));
      parts = [];
      partBytes = 0;
    };
    while (interval < intervals.length) {
      check();
      if (buffer.length < chunkBytes) buffer = Buffer.allocUnsafe(chunkBytes);
      // Consume every byte inside the budget, even when a seeking chunk would
      // cross it. The one-byte EOF probe never becomes usable source text.
      const readBytes = Math.min(chunkBytes, Math.max(1, READ_MAX_SCAN_BYTES - scanned));
      const { bytesRead } = await handle.read(buffer, 0, readBytes, position);
      check();
      if (!bytesRead) {
        if (partBytes) save(Buffer.alloc(0), true);
        break;
      }
      scanned += bytesRead;
      if (scanned > READ_MAX_SCAN_BYTES) throw new Error('source context scan exceeds byte budget');
      if (position === 0 && index && !index.prefixHash) {
        index.prefixHash = hashText(buffer.subarray(0, bytesRead));
      }
      let start = 0;
      while (start < bytesRead && interval < intervals.length) {
        const end = buffer.indexOf(10, start);
        if (end < 0 || end >= bytesRead) {
          save(buffer.subarray(start, bytesRead), false);
          break;
        }
        save(buffer.subarray(start, end), true);
        line++;
        maybeRecordReadRangeAnchor(index, line - 1, position + end + 1);
        while (interval < intervals.length && line > intervals[interval].end) interval++;
        start = end + 1;
      }
      position += bytesRead;
      // Deep windows still validate coordinates from current bytes. Amortize
      // positional IO while skipping, then return to small reads in a window.
      chunkBytes = interval < intervals.length && line < intervals[interval].start
        ? Math.min(maxChunkBytes, chunkBytes * 2)
        : minChunkBytes;
    }
    // Publication checks after its async stats, immediately before committing.
    // An unpublished result still owes a final deadline/cancellation check.
    if (!(await publishReadRangeIndex(index, handle, signal, check))) check();
    return lines;
  } finally {
    await handle.close();
  }
}
