// User-owned files (a saved Project file, the user's settings, "Save as"
// targets) are flushed to disk before the write returns, so a crash does not
// leave a NUL-filled file. An existing file is rewritten in place and keeps its
// identity (inode, hard links, ACLs, mode); only a new file is created through
// a temp file. Never backed up or moved aside: they belong to the user.
import { open, realpath } from 'node:fs/promises';

import { writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';

/** Writes `data` to `path`. A symlink stays a link (its target is written). */
export async function writeUserFile(path: string, data: string | Buffer): Promise<void> {
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A new file takes the ordinary creation mode (0o666 minus the umask).
    await writeFileAtomicAsync(path, data, { mode: 0o666 });
    return;
  }
  const handle = await open(target, 'r+');
  try {
    // Write first, then cut a longer old tail, so the file is never empty midway.
    await handle.writeFile(data);
    await handle.truncate(Buffer.byteLength(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
