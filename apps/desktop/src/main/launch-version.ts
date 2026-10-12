// The app version of the previous launch, kept as a main-process file in the
// profile. The renderer's What's new mark lives in localStorage, which Chromium
// can lose (it recreates a missing or failing Local Storage database), and an
// empty mark otherwise reads as a fresh install that announces nothing.
import { readFile, writeFile } from 'node:fs/promises';

export const LAUNCH_VERSION_FILE = 'last-launch-version';

/**
 * Records `version` as the launched version and reports whether this launch
 * follows an update: the recorded previous launch ran another version, or the
 * NSIS installer relaunched the app after an update (app-builder-lib's StartApp
 * passes `--updated`), which also covers builds that predate this record.
 */
export async function recordLaunchVersion(filePath: string, version: string, argv: readonly string[]): Promise<boolean> {
  let previous = '';
  try {
    previous = (await readFile(filePath, 'utf8')).trim();
  } catch {
    /* no earlier launch recorded */
  }
  if (previous !== version) {
    await writeFile(filePath, version, 'utf8').catch(() => undefined);
  }
  return argv.includes('--updated') || (previous !== '' && previous !== version);
}
