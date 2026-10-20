import { watch as watchFs } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Watches one file through its folder: editors and generators often replace
 *  the file (write + rename), which a watch on the file itself would lose.
 *  Returns the disposer; a folder that cannot be watched yields a no-op one. */
export function watchFile(path: string, onChange: () => void): () => void {
  const name = basename(path);
  const comparable = process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name;
  try {
    const watcher = watchFs(dirname(path), { persistent: false }, (_event, changed) => {
      if (!changed) return onChange();
      const value = String(changed);
      if ((comparable === name ? value : value.toLowerCase()) === comparable) onChange();
    });
    // A watch that dies with its folder cannot report the file's return: the
    // death itself is reported as a change, so the reload that follows finds
    // the file gone and the tab keeps looking for it (reloads.ts).
    watcher.on('error', () => onChange());
    return () => watcher.close();
  } catch {
    // Nothing to watch (missing folder, no watch capacity): no change events.
    return () => {};
  }
}
