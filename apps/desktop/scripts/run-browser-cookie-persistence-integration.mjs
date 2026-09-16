import { join } from 'node:path';

import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace(
  'mixdog-cookie-persistence-',
  async (staging) => {
    const entry = join(staging, 'cookie-persistence.mjs');
    await bundleElectronEntry({
      entry: new URL('../src/main/browser/profile-import-persistence.integration.ts', import.meta.url),
      outfile: entry,
    });
    for (const phase of ['write', 'read']) {
      const env = electronProcessEnv({
        MIXDOG_COOKIE_PERSISTENCE_TEST_ROOT: join(staging, 'profile'),
        MIXDOG_COOKIE_PERSISTENCE_TEST_PHASE: phase,
      });
      const child = spawnElectron(entry, { env });
      const code = await waitForChildExit(child, {
        timeoutMs: 30_000,
        timeoutMessage: `Cookie persistence ${phase} exceeded 30 seconds`,
        signalMessage: (signal) => `Cookie persistence ${phase} terminated by ${signal}`,
      });
      if (code !== 0) throw new Error(`Cookie persistence ${phase} failed (exit ${code})`);
    }
  },
  { maxRetries: 10, retryDelay: 150 }
);
