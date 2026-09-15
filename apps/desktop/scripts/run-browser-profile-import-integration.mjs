import { join } from 'node:path';

import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace('mixdog-browser-profile-import-integration-', async (staging) => {
  const output = join(staging, 'browser-profile-import-integration.mjs');
  await bundleElectronEntry({
    entry: new URL('../src/main/browser/profile-import.integration.ts', import.meta.url),
    outfile: output,
    plugins: [computerSourceEsbuildPlugin()],
    external: ['electron', 'ws'],
    sourcemap: 'inline',
  });
  const env = electronProcessEnv({
    MIXDOG_BROWSER_PROFILE_IMPORT_TEST_ROOT: join(staging, 'profile'),
  });
  const child = spawnElectron(output, { env });
  const exitCode = await waitForChildExit(child, {
    timeoutMs: 30_000,
    timeoutMessage: 'browser profile import integration exceeded 30 seconds',
    signalMessage: (signal) => `browser profile import integration was terminated by ${signal}`,
  });
  if (exitCode !== 0) throw new Error(`browser profile import integration failed (exit ${exitCode})`);
});
