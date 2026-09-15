// Read-only source inspection; exercise Chromium validation in an isolated profile.
// Cookie values are never read from Chrome or printed.
import { join } from 'node:path';

import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace('mixdog-cookie-diagnosis-', async (directory) => {
  const output = join(directory, 'diagnosis.mjs');
  await bundleElectronEntry({
    entry: new URL('./diagnose-cookie-metadata.ts', import.meta.url),
    outfile: output,
  });
  const env = electronProcessEnv({ MIXDOG_COOKIE_DIAGNOSIS_ROOT: directory });
  const child = spawnElectron(output, { env, args: process.argv.slice(2) });
  const code = await waitForChildExit(child, { rejectOnSignal: false, fallbackCode: null });
  if (code !== 0) process.exitCode = 1;
});
