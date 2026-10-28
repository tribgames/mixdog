import { closeSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { holdsNoData } from './atomic-file.mjs';

const PROBE_BYTES = 4096;

// Only these errno codes mean the path names no file. Every other failure
// leaves the file present (a scanner's or the running process's lock, EIO, ...):
// this is an install check on settings and status paths, so it never throws.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const presentDespite = (err) => !ABSENT_CODES.has(err?.code);

/**
 * Install check for a downloaded binary or model: false when `path` is absent
 * or its first bytes hold no data (empty, or NUL-filled by a crash that
 * committed the size but not the bytes). Cheaper than hashing a multi-GB file
 * on every use. A file that exists but cannot be opened right now (locked by a
 * scanner or by the process running it) still counts as present, as does any
 * other failure.
 */
export function fileHasData(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(PROBE_BYTES);
    return !holdsNoData(head.subarray(0, readSync(fd, head, 0, PROBE_BYTES, 0)));
  } catch (err) {
    return presentDespite(err);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Same verdict as `fileHasData`, without blocking the event loop on the open
 *  (an antivirus scan of a binary can stall a synchronous open for seconds). */
export async function fileHasDataAsync(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const head = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await handle.read(head, 0, PROBE_BYTES, 0);
    return !holdsNoData(head.subarray(0, bytesRead));
  } catch (err) {
    return presentDespite(err);
  } finally {
    await handle?.close().catch(() => {});
  }
}
