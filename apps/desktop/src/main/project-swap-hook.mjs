// Test support (not a test file): fault and pause points for a project file
// save. The desktop rewrites a file in place — replaceProjectFileBytes opens it
// `r+` and writes through that one handle — so the moments these tests used to
// reach by intercepting the rename of a temp file are the handle's own:
//
//   before(path)  runs ahead of the first write. Throwing fails the swap with
//                 nothing written; the restore that follows writes the original
//                 back unhindered, so the thrown error reaches the caller as is.
//   after(path)   runs once the new bytes are written and flushed and the
//                 handle is closed (Windows cannot rename a directory that holds
//                 an open file). It does not run for a swap that failed.
//
// Each opened handle is one swap. `path` is the string given to `open`.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

/** Installs the hooks on every `r+` open; returns a function that removes them
 *  (also registered with `t.after`). */
export function hookProjectSwap(t, { before, after } = {}) {
  const open = fs.open;
  const mock = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (args[0] !== 'r+') return handle;
    const write = handle.write.bind(handle);
    const datasync = handle.datasync.bind(handle);
    const close = handle.close.bind(handle);
    let state = 'idle';
    handle.write = async (...values) => {
      if (state === 'idle') {
        state = 'writing';
        try {
          await before?.(String(path));
        } catch (error) {
          state = 'failed';
          throw error;
        }
      }
      return write(...values);
    };
    handle.datasync = async () => {
      await datasync();
      if (state === 'writing') state = 'flushed';
    };
    handle.close = async () => {
      await close();
      if (state === 'flushed') {
        state = 'done';
        await after?.(String(path));
      }
    };
    return handle;
  });
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    mock.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
