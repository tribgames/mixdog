import { dirname, join } from 'node:path';

/** Since Electron 43 a dialog given no defaultPath opens in Downloads and the
 *  OS no longer restores the folder used last, so each set of dialogs tracks
 *  it here (in memory, for that set's lifetime). */
export function createDialogFolderMemory() {
  let lastDirectory = '';
  return {
    /** The dialog's start: the folder used last, with `fileName` inside it. */
    startIn(fileName = ''): { defaultPath?: string } {
      const defaultPath = lastDirectory && fileName ? join(lastDirectory, fileName) : lastDirectory || fileName;
      return defaultPath ? { defaultPath } : {};
    },
    /** Notes the folder of a chosen path and passes the path through. */
    remember<T extends string | undefined>(path: T): T {
      if (path) lastDirectory = dirname(path);
      return path;
    },
  };
}
