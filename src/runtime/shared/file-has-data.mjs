import { closeSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { holdsNoData } from './atomic-file.mjs';

const PROBE_BYTES = 4096;

// An open that failed for any reason but a missing path still counts as present.
const presentDespite = (err) => err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';

/**
 * Install check for a downloaded binary or model: false when `path` is absent
 * or its first bytes hold no data (empty, or NUL-filled by a crash that
 * committed the size but not the bytes). Cheaper than hashing a multi-GB file
 * on every use. A file that exists but cannot be opened right now (locked by a
 * scanner or by the process running it) still counts as present.
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
