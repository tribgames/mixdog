// Sign-ins survive a restart of the managed Browser Use profile, after a clean
// quit and after a crash: src/main/browser/login-persistence.integration.ts.
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

// One port for every phase: a cookie's site is its host, but the check loads the same origin.
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});

const failures = [];
for (const ending of ['login-clean', 'login-crash']) {
  await withTempWorkspace(
    `mixdog-login-persistence-${ending}-`,
    async (staging) => {
      const entry = join(staging, 'login-persistence.mjs');
      await bundleElectronEntry({
        entry: new URL('../src/main/browser/login-persistence.integration.ts', import.meta.url),
        outfile: entry,
      });
      for (const phase of ['warm', ending, 'check', 'signed-out']) {
        const env = electronProcessEnv({
          MIXDOG_LOGIN_PERSISTENCE_ROOT: join(staging, 'profile'),
          MIXDOG_LOGIN_PERSISTENCE_PHASE: phase,
          MIXDOG_LOGIN_PERSISTENCE_PORT: String(port),
        });
        const child = spawnElectron(entry, { env });
        const code = await waitForChildExit(child, {
          timeoutMs: 45_000,
          timeoutMessage: `Login persistence ${phase} exceeded 45 seconds`,
          // The crash phase ends itself by a kill.
          signalMessage: (signal) =>
            phase === 'login-crash' ? '' : `Login persistence ${phase} terminated by ${signal}`,
        }).catch((error) => (phase === 'login-crash' ? 0 : Promise.reject(error)));
        if (phase !== 'login-crash' && code !== 0) {
          failures.push(`${ending}: ${phase} failed (exit ${code})`);
        }
      }
    },
    { maxRetries: 10, retryDelay: 150 }
  );
}
if (failures.length) throw new Error(failures.join('\n'));
