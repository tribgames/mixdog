import { closeSync, openSync, readSync } from 'node:fs';
import { holdsNoData } from './atomic-file.mjs';

const PROBE_BYTES = 4096;

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
    return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
