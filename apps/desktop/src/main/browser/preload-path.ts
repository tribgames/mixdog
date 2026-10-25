import { join } from 'node:path';

import { app } from 'electron';

/** A preload the build emits (electron-vite's preload inputs). The built main
 *  process is CommonJS (`__dirname` is its output); sources loaded as ESM
 *  have none, so the app path stands in. */
export function builtPreloadPath(file: string): string {
  const directory =
    typeof __dirname === 'string' ? join(__dirname, '../preload') : join(app.getAppPath(), 'out/preload');
  return join(directory, file);
}
